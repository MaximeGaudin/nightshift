// Pull request mode detection: origin, gh availability and the board setting; the <environment> line it produces.
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { buildEnvironment } from "../src/server/environment.ts";
import { clearPrModeCache, detectPrMode, prModeLine } from "../src/server/prMode.ts";
import type { Board, Card } from "../src/shared/types.ts";
import { installFakeGh, removeTempDirs, tempDir } from "./helpers.ts";

const fake = installFakeGh();
const saved: Record<string, string | undefined> = {};
const root = tempDir("ns-prmode-");

function repo(remote?: string): string {
  const dir = join(root, String(Math.random()).slice(2));
  mkdirSync(dir);
  Bun.spawnSync(["git", "init", "-q", dir]);
  if (remote) Bun.spawnSync(["git", "-C", dir, "remote", "add", "origin", remote]);
  return dir;
}
const board = (extra: Partial<Board> = {}): Board => ({ version: 1, name: "b", columns: [], cards: [], nextCardNumber: 1, ...extra });

beforeAll(() => {
  for (const [k, v] of Object.entries({ ...fake.env, PATH: `${fake.dir}:${process.env.PATH}` })) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  clearPrModeCache();
  removeTempDirs();
});
beforeEach(() => {
  clearPrModeCache();
  fake.setState({ prs: [] });
});

test("inactive without a GitHub origin, with the setting off, or without auth", async () => {
  expect(await detectPrMode(repo(), board())).toMatchObject({ active: false });
  expect(await detectPrMode(repo("https://gitea.example.com/o/r.git"), board())).toMatchObject({ active: false });
  const gh = repo("git@github.com:o/r.git");
  expect(await detectPrMode(gh, board({ pullRequests: "off" }))).toMatchObject({ active: false });
  fake.setState({ auth: false, prs: [] });
  expect(await detectPrMode(gh, board())).toMatchObject({ active: false, reason: expect.stringContaining("authenticated") });
});

test("inactive when gh is not on the PATH", async () => {
  const path = process.env.PATH;
  process.env.PATH = "/usr/bin:/bin";
  try {
    expect(await detectPrMode(repo("https://github.com/o/r"), board())).toMatchObject({ active: false });
  } finally {
    process.env.PATH = path;
  }
});

test("active with GitHub and gh: settings read live, line in <environment>", async () => {
  const dir = repo("https://github.com/o/r.git");
  const mode = await detectPrMode(dir, board());
  expect(mode).toMatchObject({ active: true, hostId: "github", mergeMethod: "merge", autoMerge: false });
  expect(prModeLine(mode)).toBe("Pull requests: github via gh (merge method: merge, auto-merge: off)");
  const mode2 = await detectPrMode(dir, board({ mergeMethod: "squash", autoMerge: true }));
  expect(prModeLine(mode2)).toBe("Pull requests: github via gh (merge method: squash, auto-merge: on)");
  const card = { id: "c", number: 1, title: "t", description: "", columnId: "x", history: [] } as unknown as Card;
  const env = buildEnvironment(board(), card, {}, prModeLine(mode) as string);
  expect(env).toMatch(/Worktree policy: .*\nPull requests: github via gh/);
  expect(buildEnvironment(board(), card, {})).not.toContain("Pull requests:");
});
