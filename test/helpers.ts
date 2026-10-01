import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// bun test runs every file in one process with one module cache: settings.ts reads NIGHTSHIFT_HOME at import and
// startServer reuses globalThis.__nightshift. Any test that starts a server or touches settings therefore runs
// the server in a child process with its own NIGHTSHIFT_HOME, through this helper.

export interface ChildServer {
  base: string;
  home: string;
  skills: string;
  tmp: string;
  stop(): Promise<void>;
  call(path: string, init?: { method?: string; body?: unknown }): Promise<Response>;
}

export async function startChildServer(
  opts: { agents?: boolean; settings?: Record<string, unknown>; env?: Record<string, string> } = {},
): Promise<ChildServer> {
  const tmp = mkdtempSync(join(tmpdir(), "ns-child-"));
  const home = join(tmp, "home");
  const skills = join(tmp, "skills");
  mkdirSync(skills, { recursive: true });
  const script = join(tmp, "serve.ts");
  const src = (f: string) => JSON.stringify(join(import.meta.dir, "..", "src", "server", f));
  writeFileSync(
    script,
    `import { startServer } from ${src("server.ts")};
import { updateSettings } from ${src("settings.ts")};
updateSettings(JSON.parse(process.env.CHILD_SETTINGS ?? "{}"));
const { server, orch } = startServer({ port: 0, agents: process.env.CHILD_AGENTS === "1" });
console.log(JSON.stringify({ port: server.port }));
process.on("SIGTERM", async () => {
  await orch.shutdown();
  process.exit(0);
});
setInterval(() => {}, 1 << 30);
`,
  );
  const child = Bun.spawn(["bun", script], {
    cwd: tmp,
    env: {
      ...process.env,
      NIGHTSHIFT_HOME: home,
      NIGHTSHIFT_USER_SKILLS: skills,
      NODE_ENV: "production",
      CHILD_AGENTS: opts.agents ? "1" : "0",
      CHILD_SETTINGS: JSON.stringify(opts.settings ?? {}),
      ...opts.env,
    },
    stdout: "pipe",
    stderr: "inherit",
  });
  const decoder = new TextDecoder();
  let out = "";
  for await (const chunk of child.stdout) {
    out += decoder.decode(chunk);
    if (out.includes("\n")) break;
  }
  const { port } = JSON.parse(out);
  const base = `http://localhost:${port}`;
  return {
    base,
    home,
    skills,
    tmp,
    async stop() {
      child.kill("SIGTERM");
      await child.exited;
    },
    call(path, init = {}) {
      return fetch(base + path, {
        method: init.method ?? (init.body === undefined ? "GET" : "POST"),
        headers: { "content-type": "application/json" },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
      });
    },
  };
}

export async function waitFor(fn: () => Promise<boolean> | boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await Bun.sleep(25);
  }
  throw new Error("timeout");
}
