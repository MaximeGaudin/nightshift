import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Runs in a child process: importing the server modules here would fix NIGHTSHIFT_HOME for every test file.
const tmp = mkdtempSync(join(tmpdir(), "ns-dir-"));
const run = (code: string) => {
  const r = Bun.spawnSync(
    [
      "bun",
      "-e",
      `import { persistScreenshots, screenshotsDir } from ${JSON.stringify(join(import.meta.dir, "../src/server/screenshots.ts"))};\n${code}`,
    ],
    {
      env: { ...process.env, NIGHTSHIFT_HOME: join(tmp, "home") },
    },
  );
  return r.stdout.toString().trim();
};

test("screenshotsDir rejects dubious card ids", () => {
  const out = run(
    `for (const id of ["../etc", "a/b", "", "card_a-1"]) { try { console.log(screenshotsDir(id)); } catch { console.log("ERR"); } }`,
  );
  expect(out.split("\n")).toEqual(["ERR", "ERR", "ERR", join(tmp, "home", "screenshots", "card_a-1")]);
});

test("persistScreenshots ignores paths that escape the captures folder", () => {
  mkdirSync(join(tmp, "nightshift-screenshots"));
  writeFileSync(join(tmp, "secret.png"), "x");
  const desc = `![S](${join(tmp, "nightshift-screenshots")}/../secret.png)`;
  expect(run(`console.log(persistScreenshots("card_a", ${JSON.stringify(desc)}))`)).toBe(desc);
});
