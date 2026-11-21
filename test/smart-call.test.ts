import { afterAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildSmartPrompt, readMcpServerNames, runSmart, smartArgs, smartFingerprint } from "../src/server/smart.ts";
import { removeTempDirs, tempDir } from "./helpers.ts";

const fake = join(import.meta.dir, "fake-claude.ts");
const prompt = (title: string, description = "d") =>
  buildSmartPrompt({ title, description, columnName: "Merge", skill: "nightshift-merge", mcpServers: ["linear"] });
const call = (title: string, timeoutMs?: number) =>
  runSmart({ claudePath: fake, cwd: import.meta.dir, env: process.env, prompt: prompt(title), ...(timeoutMs ? { timeoutMs } : {}) });

afterAll(() => removeTempDirs());

test("runSmart: a valid output gives the choice and its cost", async () => {
  const r = await call("normal");
  expect(r).toMatchObject({
    ok: true,
    choice: { features: { mcp: true, chrome: false, hooks: false, userSettings: true }, effort: "high", reason: "fake smart" },
    costUsd: 0.0012,
  });
});

test("runSmart: an error result and an invalid output fail, keeping their cost", async () => {
  expect(await call("smart-fail")).toMatchObject({ ok: false, reason: "smart boom", costUsd: 0.0005 });
  expect(await call("smart-invalid")).toMatchObject({ ok: false, reason: "invalid output", costUsd: 0.0012 });
});

test("runSmart timeout: resolves quickly and the child is dead", async () => {
  let pid = 0;
  let proc: { exitCode: number | null; signalCode: string | null } | undefined;
  const started = Date.now();
  const r = await runSmart({
    claudePath: fake,
    cwd: import.meta.dir,
    env: process.env,
    prompt: prompt("smart-slow"),
    timeoutMs: 300,
    onSpawn: (p) => {
      pid = p.pid;
      proc = p as never;
    },
  });
  expect(Date.now() - started).toBeLessThan(3000);
  expect(r).toMatchObject({ ok: false, reason: "timeout after 300 ms" });
  expect(pid).toBeGreaterThan(0);
  expect(proc?.exitCode !== null || proc?.signalCode !== null).toBe(true);
});

test("runSmart: a missing binary fails without throwing", async () => {
  const r = await runSmart({ claudePath: "/nonexistent/claude", cwd: import.meta.dir, env: process.env, prompt: "x" });
  expect(r.ok).toBe(false);
});

test("smartArgs: haiku, low effort, nothing of the user's setup, no tools", () => {
  const a = smartArgs("claude");
  expect(a.slice(0, 6)).toEqual(["claude", "-p", "--model", "haiku", "--effort", "low"]);
  for (const flag of ["--strict-mcp-config", "--no-chrome", "--no-session-persistence"]) expect(a).toContain(flag);
  expect(a[a.indexOf("--tools") + 1]).toBe("");
  expect(a[a.indexOf("--setting-sources") + 1]).toBe("project,local");
  expect(a).not.toContain("--resume");
});

test("readMcpServerNames: names only, from the three sources, sorted and unique", () => {
  const dir = tempDir("ns-mcp-");
  const project = join(dir, "proj");
  mkdirSync(project);
  const claudeJson = join(dir, ".claude.json");
  writeFileSync(
    claudeJson,
    JSON.stringify({
      mcpServers: { slack: { command: "x", env: { TOKEN: "SECRET-1" } }, linear: { url: "https://secret.example" } },
      projects: { [project]: { mcpServers: { figma: { env: { KEY: "SECRET-2" } } } }, "/other": { mcpServers: { nope: {} } } },
    }),
  );
  writeFileSync(join(project, ".mcp.json"), JSON.stringify({ mcpServers: { linear: {}, sentry: { headers: { a: "SECRET-3" } } } }));
  const names = readMcpServerNames(project, claudeJson);
  expect(names).toEqual(["figma", "linear", "sentry", "slack"]);
  const text = buildSmartPrompt({ title: "t", description: "d", columnName: "c", skill: "s", mcpServers: names });
  expect(text).not.toContain("SECRET");
  expect(text).not.toContain("secret.example");
  expect(readMcpServerNames(join(dir, "missing"), join(dir, "nope.json"))).toEqual([]);
  writeFileSync(claudeJson, "{not json");
  expect(readMcpServerNames(project, claudeJson)).toEqual(["linear", "sentry"]);
});

test("buildSmartPrompt truncates a long description; fingerprint follows title, description and skill", () => {
  const text = buildSmartPrompt({ title: "t", description: "x".repeat(5000), columnName: "c", skill: "s", mcpServers: [] });
  expect(text).toContain("…[tronqué]");
  expect(text).not.toContain("x".repeat(4001));
  const f = smartFingerprint("t", "d", "s");
  expect(f).toHaveLength(16);
  expect(smartFingerprint("t", "d", "s")).toBe(f);
  expect(smartFingerprint("t", "d2", "s")).not.toBe(f);
  expect(smartFingerprint("t", "d", "s2")).not.toBe(f);
});
