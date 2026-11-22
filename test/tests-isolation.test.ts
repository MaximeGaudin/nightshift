import { afterAll, beforeAll, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { type ChildServer, keepSettingsGlobal, settingsGlobal, startChildServer } from "./helpers.ts";

test("tests-isolation: the test run never targets the real ~/.nightshift", () => {
  expect(process.env.NIGHTSHIFT_HOME).toBeTruthy();
  expect(process.env.NIGHTSHIFT_HOME).not.toBe(join(homedir(), ".nightshift"));
  expect(process.env.NIGHTSHIFT_USER_SKILLS).toBeTruthy();
});

let a: ChildServer;
let b: ChildServer;
beforeAll(async () => {
  [a, b] = await Promise.all([startChildServer(), startChildServer()]);
});
afterAll(() => Promise.all([a.stop(), b.stop()]));

test("tests-isolation: two servers with different NIGHTSHIFT_HOME share neither settings nor projects", async () => {
  expect(a.home).not.toBe(b.home);
  await a.call("/api/settings", { method: "PUT", body: { claudePath: "/tmp/only-in-a" } });
  await a.call("/api/projects/open", { body: { path: a.tmp } });
  const sa = await a.call("/api/settings").then((r) => r.json());
  const sb = await b.call("/api/settings").then((r) => r.json());
  expect(sa.claudePath).toBe("/tmp/only-in-a");
  expect(sb.claudePath).not.toBe("/tmp/only-in-a");
  expect(sa.recentProjects).toContain(a.tmp);
  expect(sb.recentProjects).not.toContain(a.tmp);
});

test("tests-isolation: keepSettingsGlobal puts back the very object a module already captured", async () => {
  await import("../src/server/settings.ts");
  const before = settingsGlobal().__nightshiftSettings;
  expect(before).toBeDefined();
  const kept = keepSettingsGlobal();
  settingsGlobal().__nightshiftSettings = undefined;
  kept.restore();
  expect(settingsGlobal().__nightshiftSettings).toBe(before);
});

// The real cross-file scenario of the bug: environment-prompt.test.ts makes settings.ts capture the global,
// issue-tokens.test.ts resets it to get fresh instances, nightshift.test.ts then reads it from the module cache.
// Whatever the CI grouping, a file that leaves `__nightshiftSettings` undefined fails this run.
test("tests-isolation: files that reset the settings global do not break the files that follow", async () => {
  const proc = Bun.spawn(
    [
      process.execPath,
      "test",
      "./test/environment-prompt.test.ts",
      "./test/issue-tokens.test.ts",
      "./test/nightshift.test.ts",
      "-t",
      "soundNotifications|token-store",
    ],
    { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" },
  );
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) console.error(out + err);
  expect(code).toBe(0);
}, 120000);
