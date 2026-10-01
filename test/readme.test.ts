import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const readme = readFileSync(join(root, "README.md"), "utf8");
const bannerPath = join(root, "docs/assets/readme-banner.svg");
const boardPath = join(root, "docs/assets/board.png");

const slug = (heading: string) =>
  heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s/g, "-");

describe("readme", () => {
  test("readme-banner-referenced", () => {
    const marker = "![Nightshift banner](docs/assets/readme-banner.svg)";
    const idx = readme.indexOf(marker);
    expect(idx).toBeGreaterThan(-1);
    expect(idx).toBeLessThan(readme.indexOf("\n## "));
    expect(existsSync(bannerPath)).toBe(true);
  });

  test("readme-no-stale-refs", () => {
    expect(readme).not.toContain("<repo-url>");
    expect(readme).not.toContain("nightshift-screenshots/");
    expect(readme).not.toContain('<img src="docs/logo/logo.svg"');
  });

  test("readme-board-screenshot", () => {
    expect(readme).toContain("docs/assets/board.png");
    expect(existsSync(boardPath)).toBe(true);
    const head = readFileSync(boardPath).subarray(0, 4);
    expect(head.toString("hex").toUpperCase()).toBe("89504E47");
  });

  test("readme-anchors-resolve", () => {
    const slugs = new Set([...readme.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => slug(m[1] ?? "")));
    const anchors = [...readme.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1] ?? "");
    expect(anchors.length).toBeGreaterThan(0);
    for (const a of anchors) expect(slugs.has(a)).toBe(true);
  });

  test("readme-quick-start-block", () => {
    const start = readme.indexOf("## Quick start");
    const section = readme.slice(start, readme.indexOf("\n## ", start + 1));
    const block = /```sh\n([\s\S]*?)```/.exec(section)?.[1];
    expect(block).toBeDefined();
    const lines = (block ?? "").split("\n").filter((l) => l.trim());
    for (const cmd of ["git clone https://github.com/MaximeGaudin/nightshift.git", "bun install", 'claude -p "hi"', "bun start"]) {
      const line = lines.find((l) => l.includes(cmd));
      expect(line).toBeDefined();
      expect(line).toContain("#");
    }
    for (const l of lines) expect(l).toContain("#");
  });

  test("readme-english-only", () => {
    expect(/[À-ÿ]/.test(readme)).toBe(false);
  });
});

describe("banner", () => {
  test("banner-safe-for-github", () => {
    const svg = readFileSync(bannerPath, "utf8");
    for (const s of ['role="img"', "aria-label=", 'viewBox="0 0 1200 300"', "<animate"]) expect(svg).toContain(s);
    for (const s of ["<script", "<foreignObject", "<image", "@import", "@keyframes"]) expect(svg).not.toContain(s);
    expect(svg.replace(/xmlns="[^"]*"/g, "")).not.toContain("http");
  });
});
