import { copyFileSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, sep } from "node:path";
import { MAX_CARD_IMAGE_BYTES } from "../shared/screenshots.ts";
import { screenshotImages, screenshotsDir } from "./screenshots.ts";

export const SCREENSHOTS_START = "<!-- nightshift-screenshots:start -->";
export const SCREENSHOTS_END = "<!-- nightshift-screenshots:end -->";
/** Tag of the single prerelease that hosts every card's captures in a repository. */
export const SCREENSHOTS_RELEASE = "nightshift-screenshots";
const GH_TIMEOUT_MS = 30_000;
const LOG_PREFIX = "Screenshots non ajoutés à la PR : ";

/**
 * Puts the screenshots block (between the two markers) into a PR body. When both markers are there, only the
 * text between them (markers included) is replaced; otherwise the block is appended. Text outside the markers is
 * kept byte for byte, and applying it twice with the same images gives the same body.
 */
export function mergeScreenshotsSection(body: string, images: { alt: string; url: string }[]): string {
  const lines = images.map((i) => `![${i.alt}](${i.url})`).join("\n");
  const block = `${SCREENSHOTS_START}\n## Screenshots\n\n${lines}\n${SCREENSHOTS_END}`;
  const start = body.indexOf(SCREENSHOTS_START);
  const end = start >= 0 ? body.indexOf(SCREENSHOTS_END, start) : -1;
  if (start >= 0 && end >= 0) return body.slice(0, start) + block + body.slice(end + SCREENSHOTS_END.length);
  return body ? `${body}\n\n${block}` : block;
}

export interface GhResult {
  code: number;
  stdout: string;
  stderr: string;
  /** The gh binary could not be started (not installed, wrong path). */
  missing?: boolean;
}
export type GhRunner = (args: string[], opts: { cwd: string; stdin?: string }) => Promise<GhResult>;

/** Runs `gh` (or `$NIGHTSHIFT_GH`) with a 30 s timeout. Never rejects. */
export const runGh: GhRunner = async (args, { cwd, stdin }) => {
  const bin = process.env.NIGHTSHIFT_GH ?? "gh";
  let proc: Bun.Subprocess<"pipe" | "ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn([bin, ...args], {
      cwd,
      env: process.env,
      stdin: stdin !== undefined ? "pipe" : "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (e) {
    return { code: -1, stdout: "", stderr: (e as Error).message, missing: true };
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, GH_TIMEOUT_MS);
  try {
    if (stdin !== undefined && proc.stdin && typeof proc.stdin !== "number") {
      proc.stdin.write(stdin);
      await proc.stdin.end();
    }
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (timedOut) return { code: -1, stdout, stderr: `gh ${args[0]} ${args[1] ?? ""}: timeout after 30 s` };
    return { code, stdout, stderr };
  } catch (e) {
    return { code: -1, stdout: "", stderr: (e as Error).message };
  } finally {
    clearTimeout(timer);
  }
};

class SyncError extends Error {}

function failure(r: GhResult, what: string): SyncError {
  const line = r.stderr.split("\n").find((l) => l.trim()) ?? "";
  return new SyncError((line.trim() || `${what} exited with ${r.code}`).slice(0, 200));
}

interface Asset {
  name: string;
  size: number;
  url: string;
}

async function viewRelease(gh: GhRunner, cwd: string): Promise<{ ok: true; assets: Asset[] } | { ok: false; res: GhResult }> {
  const r = await gh(["release", "view", SCREENSHOTS_RELEASE, "--json", "assets"], { cwd });
  if (r.missing) throw new SyncError("gh introuvable");
  if (r.code !== 0) return { ok: false, res: r };
  try {
    const assets = (JSON.parse(r.stdout) as { assets?: Asset[] }).assets ?? [];
    return { ok: true, assets };
  } catch {
    throw new SyncError("invalid JSON from gh release view");
  }
}

/**
 * Adds the card's stored captures to the description of the open PR of its branch `nightshift/<cardId>`, hosting
 * the images as assets of the repository's `nightshift-screenshots` prerelease. No captures or no open PR: does
 * nothing and logs nothing. Any other failure is logged as one `info` line. Never rejects.
 */
export async function syncPrScreenshots(opts: {
  projectPath: string;
  cardId: string;
  description: string;
  log: (text: string) => void;
  gh?: GhRunner;
}): Promise<void> {
  const { projectPath: cwd, cardId, description, log } = opts;
  const gh = opts.gh ?? runGh;
  let tmp: string | undefined;
  try {
    let dir: string;
    try {
      dir = realpathSync(screenshotsDir(cardId)) + sep;
    } catch {
      return; // Bad card id, or no stored captures.
    }
    // The real file must sit in the card's stored captures: `..` or a symlink must not publish another file.
    const seen = new Set<string>();
    const images: { alt: string; path: string }[] = [];
    for (const i of screenshotImages(description)) {
      let real: string;
      try {
        real = realpathSync(i.path);
        const st = statSync(real);
        if (!real.startsWith(dir) || !st.isFile() || st.size > MAX_CARD_IMAGE_BYTES) continue;
      } catch {
        continue;
      }
      if (seen.has(real)) continue;
      seen.add(real);
      images.push({ alt: i.alt, path: real });
    }
    if (images.length === 0) return;

    const view = await gh(["pr", "view", `nightshift/${cardId}`, "--json", "url,body,state"], { cwd });
    if (view.missing) throw new SyncError("gh introuvable");
    if (view.code !== 0) return; // No PR for this branch (or no GitHub remote): silent.
    let pr: { url: string; body: string; state: string };
    try {
      pr = JSON.parse(view.stdout);
    } catch {
      throw new SyncError("invalid JSON from gh pr view");
    }
    if (pr.state !== "OPEN" || typeof pr.url !== "string") return;
    const body = typeof pr.body === "string" ? pr.body : "";

    let release = await viewRelease(gh, cwd);
    if (!release.ok) {
      const created = await gh(
        [
          "release",
          "create",
          SCREENSHOTS_RELEASE,
          "--prerelease",
          "--title",
          "Nightshift screenshots",
          "--notes",
          "Captures attached to pull requests by Nightshift. Do not delete.",
        ],
        { cwd },
      );
      // Another card may have created it in the meantime: look again before giving up.
      release = await viewRelease(gh, cwd);
      if (!release.ok) throw failure(created.code !== 0 ? created : release.res, "gh release create");
    }

    let assets = release.assets;
    const assetName = (path: string) => `${cardId}-${basename(path)}`;
    const toUpload = images.filter((i) => {
      const size = statSync(i.path).size;
      return !assets.some((a) => a.name === assetName(i.path) && a.size === size);
    });
    if (toUpload.length > 0) {
      // gh names an asset after its file: copy each capture under its asset name first.
      tmp = mkdtempSync(join(tmpdir(), "ns-pr-shots-"));
      const files = toUpload.map((i) => {
        const f = join(tmp as string, assetName(i.path));
        copyFileSync(i.path, f);
        return f;
      });
      const up = await gh(["release", "upload", SCREENSHOTS_RELEASE, ...files, "--clobber"], { cwd });
      if (up.missing) throw new SyncError("gh introuvable");
      if (up.code !== 0) throw failure(up, "gh release upload");
      const after = await viewRelease(gh, cwd);
      if (!after.ok) throw failure(after.res, "gh release view");
      assets = after.assets;
    }

    const linked = images.map((i) => {
      const asset = assets.find((a) => a.name === assetName(i.path));
      if (!asset?.url) throw new SyncError(`asset ${assetName(i.path)} missing from the release`);
      return { alt: i.alt, url: asset.url };
    });
    const next = mergeScreenshotsSection(body, linked);
    if (next === body) return;
    const edit = await gh(["pr", "edit", pr.url, "--body-file", "-"], { cwd, stdin: next });
    if (edit.missing) throw new SyncError("gh introuvable");
    if (edit.code !== 0) throw failure(edit, "gh pr edit");
  } catch (e) {
    log(LOG_PREFIX + (e instanceof SyncError ? e.message : (e as Error).message || String(e)).slice(0, 200));
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
}
