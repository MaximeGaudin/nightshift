import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** The line Nightshift keeps in a project's `info/exclude`, so agent captures never show up in git. */
export const SCREENSHOTS_EXCLUDE_LINE = "nightshift-screenshots/";

export type ExcludeResult = { ok: true; changed: boolean } | { ok: false; reason: string };

/**
 * Adds `nightshift-screenshots/` to `<git-common-dir>/info/exclude` of the repository holding `projectPath`.
 * The common dir is shared by every worktree of the repository, so one line covers all of them. The versioned
 * `.gitignore` is never touched. Idempotent; never throws.
 */
export function ensureScreenshotsExcluded(projectPath: string): ExcludeResult {
  let common: string;
  try {
    const proc = Bun.spawnSync(["git", "rev-parse", "--git-common-dir"], { cwd: projectPath, stdout: "pipe", stderr: "pipe" });
    const out = proc.stdout.toString().trim();
    if (proc.exitCode !== 0 || !out) return { ok: false, reason: "not a git repository" };
    // Relative (".git") from the main checkout, absolute from a linked worktree.
    common = resolve(projectPath, out);
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
  try {
    const file = join(common, "info", "exclude");
    const current = existsSync(file) ? readFileSync(file, "utf8") : "";
    if (current.split(/\r?\n/).some((l) => l.trim() === SCREENSHOTS_EXCLUDE_LINE)) return { ok: true, changed: false };
    mkdirSync(dirname(file), { recursive: true });
    const sep = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
    writeFileSync(file, `${current}${sep}${SCREENSHOTS_EXCLUDE_LINE}\n`);
    return { ok: true, changed: true };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}
