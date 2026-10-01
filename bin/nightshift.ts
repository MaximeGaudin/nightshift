#!/usr/bin/env bun
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { type CliOptions, openBrowser, parseArgs, USAGE } from "../src/server/cli.ts";
import { startServer } from "../src/server/server.ts";
import { setSettingsReadOnly } from "../src/server/settings.ts";

// Bun reads bunfig.toml (and its Tailwind plugin) from the working directory only. When started elsewhere,
// e.g. as a linked `nightshift` binary, re-run from the repository root and keep the caller's directory.
const root = resolve(import.meta.dir, "..");
if (realpathSync(process.cwd()) !== realpathSync(root)) {
  const child = Bun.spawn([process.execPath, import.meta.path, ...process.argv.slice(2)], {
    cwd: root,
    env: { ...process.env, NIGHTSHIFT_CWD: process.env.NIGHTSHIFT_CWD ?? process.cwd() },
    stdio: ["inherit", "inherit", "inherit"],
  });
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => child.kill(sig));
  process.exit(await child.exited);
}

let opts: CliOptions;
try {
  opts = parseArgs(process.argv.slice(2), process.env);
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(2);
}
if (opts.help) {
  console.log(USAGE);
  process.exit(0);
}
const { port, dir, open, agents } = opts;
// A --no-agents instance is a test run started from a card's worktree: it must not rewrite the user's settings.
if (!agents) setSettingsReadOnly(true);

const { server, orch } = startServer({ port, agents, development: process.env.NODE_ENV !== "production" });
const project = resolve(process.env.NIGHTSHIFT_CWD ?? process.cwd(), dir ?? ".");
let url = `http://localhost:${server.port}/`;
try {
  orch.open(project);
  url += `?project=${encodeURIComponent(project)}`;
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e));
}
console.log(`Nightshift running at ${url}`);
// NIGHTSHIFT_NO_OPEN lets an agent start the app for screenshots without popping a browser for the human.
if (open && !process.env.NIGHTSHIFT_NO_OPEN) openBrowser(url);

// Agents and test commands must not outlive the CLI, whatever ends it.
let stopping = false;
const stop = (code: number) => {
  if (stopping) return;
  stopping = true;
  orch.shutdown().finally(() => process.exit(code));
};
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => stop(0));
for (const event of ["uncaughtException", "unhandledRejection"] as const) {
  process.on(event, (e) => {
    console.error(`${event}:`, e);
    stop(1);
  });
}
