#!/usr/bin/env bun
import { resolve } from "node:path";
import { startServer } from "../src/server/server.ts";

const argv = process.argv.slice(2);
let port = Number(process.env.PORT) || 4545;
let dir: string | undefined;
let open = true;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (a === "--port" || a === "-p") port = Number(argv[++i]);
  else if (a === "--no-open") open = false;
  else if (a === "--help" || a === "-h") {
    console.log("Usage: nightshift [project-dir] [--port 4545] [--no-open]");
    process.exit(0);
  } else dir = a;
}

const { server, orch } = startServer({ port, development: process.env.NODE_ENV !== "production" });
const project = resolve(dir ?? process.cwd());
let url = `http://localhost:${server.port}/`;
try {
  orch.open(project);
  url += `?project=${encodeURIComponent(project)}`;
} catch (e: any) {
  console.error(e.message);
}
console.log(`Nightshift running at ${url}`);
if (open) Bun.spawn([process.platform === "darwin" ? "open" : "xdg-open", url], { stdout: "ignore", stderr: "ignore" });

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    orch.shutdown();
    process.exit(0);
  });
}
