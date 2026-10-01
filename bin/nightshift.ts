#!/usr/bin/env bun
import { resolve } from "node:path";
import { type CliOptions, parseArgs, USAGE } from "../src/server/cli.ts";
import { startServer } from "../src/server/server.ts";

let opts: CliOptions;
try {
  opts = parseArgs(process.argv.slice(2), process.env);
} catch (e: any) {
  console.error(e.message);
  process.exit(2);
}
if (opts.help) {
  console.log(USAGE);
  process.exit(0);
}
const { port, dir, open, agents } = opts;

const { server, orch } = startServer({ port, agents, development: process.env.NODE_ENV !== "production" });
const project = resolve(dir ?? process.cwd());
let url = `http://localhost:${server.port}/`;
try {
  orch.open(project);
  url += `?project=${encodeURIComponent(project)}`;
} catch (e: any) {
  console.error(e.message);
}
console.log(`Nightshift running at ${url}`);
// NIGHTSHIFT_NO_OPEN lets an agent start the app for screenshots without popping a browser for the human.
if (open && !process.env.NIGHTSHIFT_NO_OPEN)
  Bun.spawn([process.platform === "darwin" ? "open" : "xdg-open", url], { stdout: "ignore", stderr: "ignore" });

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    orch.shutdown().finally(() => process.exit(0));
  });
}
