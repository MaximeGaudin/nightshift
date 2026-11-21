import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** The line Nightshift keeps in a project's `info/exclude`, so agent captures never show up in git. */
export const SCREENSHOTS_EXCLUDE_LINE = "nightshift-screenshots/";

export type ExcludeResult = { ok: true; changed: boolean } | { ok: false; reason: string };

/**
 * The repository's common git dir (what `git rev-parse --git-common-dir` prints), read from the files rather than
 * by running git: in the server process, a synchronous child process right before the agent's `Bun.spawn` makes
 * Bun 1.2 segfault. Walks up from `start` to the first `.git`: a directory is the common dir itself; a file
 * (`gitdir: <dir>`, a linked worktree or a submodule) points at a git dir whose `commondir` file, when present,
 * names the common dir relative to it. Null outside a repository.
 */
export function gitCommonDir(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    const dotGit = join(dir, ".git");
    if (existsSync(dotGit)) {
      if (statSync(dotGit).isDirectory()) return dotGit;
      const m = readFileSync(dotGit, "utf8").match(/^gitdir:\s*(.+?)\s*$/m);
      if (!m) return null;
      const gitDir = resolve(dir, m[1]);
      const commonFile = join(gitDir, "commondir");
      return existsSync(commonFile) ? resolve(gitDir, readFileSync(commonFile, "utf8").trim()) : gitDir;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Adds `nightshift-screenshots/` to `<git-common-dir>/info/exclude` of the repository holding `projectPath`.
 * The common dir is shared by every worktree of the repository, so one line covers all of them. The versioned
 * `.gitignore` is never touched. Idempotent; never throws.
 */
export function ensureScreenshotsExcluded(projectPath: string): ExcludeResult {
  let common: string | null;
  try {
    common = gitCommonDir(projectPath);
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
  if (!common) return { ok: false, reason: "not a git repository" };
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
