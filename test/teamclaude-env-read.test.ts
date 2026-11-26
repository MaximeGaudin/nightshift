import { afterAll, afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { prepareProxyEnv } from "../src/server/teamclaude.ts";
import { removeTempDirs, tempDir } from "./helpers.ts";

// A fake `teamclaude` first on PATH. Its behavior is read from `mode` on every call: "ok" prints the env, "slow-once"
// hangs on the first call only, "fail" exits 1. `calls` counts the calls.
const bin = tempDir("ns-tc-env-bin-");
const modeFile = join(bin, "mode");
const callsFile = join(bin, "calls");
writeFileSync(
  join(bin, "teamclaude"),
  `#!/bin/sh
n=$(cat ${JSON.stringify(callsFile)} 2>/dev/null || echo 0)
echo $((n + 1)) > ${JSON.stringify(callsFile)}
mode=$(cat ${JSON.stringify(modeFile)})
if [ "$mode" = fail ]; then echo "boom" >&2; exit 1; fi
if [ "$mode" = slow-once ] && [ "$n" = 0 ]; then exec sleep 5; fi
echo "export HTTPS_PROXY=http://127.0.0.1:3456"
`,
);
chmodSync(join(bin, "teamclaude"), 0o755);
const savedPath = process.env.PATH;
process.env.PATH = `${bin}:${savedPath}`;

const servers: ReturnType<typeof Bun.serve>[] = [];
/** A fresh proxy per test, so each test starts with no last good read for its URL. */
const proxy = () => {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ accounts: [], aggregate: {} }) });
  servers.push(s);
  return `http://127.0.0.1:${s.port}`;
};
const setup = (mode: string) => {
  writeFileSync(modeFile, mode);
  writeFileSync(callsFile, "0");
};
const calls = () => (existsSync(callsFile) ? Number(readFileSync(callsFile, "utf8").trim()) : 0);
const ENV = { set: { HTTPS_PROXY: "http://127.0.0.1:3456" }, unset: [] };

afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});
afterAll(() => {
  process.env.PATH = savedPath;
  removeTempDirs();
});

test("teamclaude-env-retry: a read that times out is tried once more while the proxy answers", async () => {
  setup("slow-once");
  expect(await prepareProxyEnv(proxy(), 300)).toEqual({ ok: true, env: ENV });
  expect(calls()).toBe(2);
});

test("teamclaude-env-last-good: a failed read reuses the last good one for that URL, without a retry", async () => {
  const url = proxy();
  setup("ok");
  expect(await prepareProxyEnv(url, 1000)).toEqual({ ok: true, env: ENV });
  setup("fail");
  expect(await prepareProxyEnv(url, 1000)).toEqual({ ok: true, env: ENV });
  expect(calls()).toBe(1);
});

test("teamclaude-env-failed: two failed reads with nothing to fall back on are reported", async () => {
  setup("fail");
  expect(await prepareProxyEnv(proxy(), 1000)).toEqual({ ok: false, failure: { kind: "env-failed", detail: "boom" } });
  expect(calls()).toBe(2);
});
