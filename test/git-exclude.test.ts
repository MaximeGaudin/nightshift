import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureScreenshotsExcluded } from "../src/server/gitExclude.ts";
import { removeTempDirs, tempDir } from "./helpers.ts";

afterAll(removeTempDirs);

const git = (cwd: string, ...args: string[]) => {
  const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
  return p.stdout.toString();
};

/** A git repository with one commit and no `info/exclude`. */
function repo(): string {
  const dir = tempDir("ns-exclude-");
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  writeFileSync(join(dir, "a.txt"), "a\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "init");
  rmSync(join(dir, ".git", "info"), { recursive: true, force: true });
  return dir;
}

const excludeOf = (dir: string) => join(dir, ".git", "info", "exclude");

test("exclude-adds-line", () => {
  const dir = repo();
  expect(ensureScreenshotsExcluded(dir)).toEqual({ ok: true, changed: true });
  expect(readFileSync(excludeOf(dir), "utf8")).toBe("nightshift-screenshots/\n");
});

test("exclude-idempotent", () => {
  const dir = repo();
  mkdirSync(join(dir, ".git", "info"));
  writeFileSync(excludeOf(dir), "foo\n  nightshift-screenshots/  ");
  expect(ensureScreenshotsExcluded(dir)).toEqual({ ok: true, changed: false });
  expect(ensureScreenshotsExcluded(dir)).toEqual({ ok: true, changed: false });
  expect(readFileSync(excludeOf(dir), "utf8")).toBe("foo\n  nightshift-screenshots/  ");
});

test("exclude-no-newline", () => {
  const dir = repo();
  mkdirSync(join(dir, ".git", "info"));
  writeFileSync(excludeOf(dir), "foo");
  ensureScreenshotsExcluded(dir);
  ensureScreenshotsExcluded(dir);
  expect(readFileSync(excludeOf(dir), "utf8")).toBe("foo\nnightshift-screenshots/\n");
});

test("exclude-worktree", () => {
  const dir = repo();
  const wt = join(tempDir("ns-exclude-wt-"), "wt");
  git(dir, "worktree", "add", "-q", "-b", "card", wt);
  expect(ensureScreenshotsExcluded(wt)).toEqual({ ok: true, changed: true });
  expect(readFileSync(excludeOf(dir), "utf8")).toBe("nightshift-screenshots/\n");
  // Same common dir from the main checkout: nothing more to add.
  expect(ensureScreenshotsExcluded(dir)).toEqual({ ok: true, changed: false });
  mkdirSync(join(wt, "nightshift-screenshots"));
  writeFileSync(join(wt, "nightshift-screenshots", "01.png"), "x");
  expect(git(wt, "status", "--porcelain")).toBe("");
});

test("exclude-gitignore-untouched", () => {
  const dir = repo();
  writeFileSync(join(dir, ".gitignore"), "node_modules");
  git(dir, "add", ".gitignore");
  git(dir, "commit", "-qm", "ignore");
  ensureScreenshotsExcluded(dir);
  expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe("node_modules");
  expect(git(dir, "status", "--porcelain")).toBe("");
});

test("exclude-not-git", () => {
  const dir = tempDir("ns-exclude-nogit-");
  const r = ensureScreenshotsExcluded(dir);
  expect(r.ok).toBe(false);
  expect(existsSync(join(dir, ".git"))).toBe(false);
  expect(ensureScreenshotsExcluded(join(dir, "missing")).ok).toBe(false);
});
