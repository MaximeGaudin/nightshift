import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// bun test runs every file in one process with one module cache: settings.ts reads NIGHTSHIFT_HOME at import and
// startServer reuses globalThis.__nightshift. Any test that starts a server or touches settings therefore runs
// the server in a child process with its own NIGHTSHIFT_HOME, through this helper.

const tempDirs: string[] = [];

/** Creates a temporary directory removed by `removeTempDirs()` (call it from `afterAll`). */
export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

export function removeTempDirs() {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

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
      rmSync(tmp, { recursive: true, force: true });
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

/** Bounded wait for something that must NOT happen: an absence has no observable condition to poll, so a late event gets this long to show up. */
export const quiet = (ms = 300) => Bun.sleep(ms);

/** Opens a fresh project with a one-skill column then an inert one, and adds a card (the agent starts at once). */
export async function addAgentCard(srv: ChildServer, title: string) {
  const { mkdirSync, mkdtempSync, writeFileSync } = await import("node:fs");
  mkdirSync(join(srv.skills, "enrich"), { recursive: true });
  writeFileSync(join(srv.skills, "enrich", "SKILL.md"), "---\nname: enrich\ndescription: test\n---\n");
  const dir = mkdtempSync(join(srv.tmp, "proj-"));
  await srv.call("/api/projects/open", { body: { path: dir } });
  const board = await srv
    .call("/api/board", {
      method: "PUT",
      body: {
        project: dir,
        columns: [
          { name: "Work", type: "skill", skill: "enrich" },
          { name: "Done", type: "inert" },
        ],
      },
    })
    .then((r) => r.json());
  const { id } = await srv.call("/api/cards", { body: { project: dir, columnId: board.board.columns[1].id, title } }).then((r) => r.json());
  const card = async () => {
    const snap = await srv.call(`/api/project?project=${encodeURIComponent(dir)}`).then((r) => r.json());
    return snap.board.cards.find((c: { id: string }) => c.id === id);
  };
  return { dir, id, card };
}

/** Narrows a value that the test setup guarantees (an array element, a lookup): fails loudly instead of using `!`. */
export function must<T>(value: T | null | undefined, what = "value"): T {
  if (value === null || value === undefined) throw new Error(`Expected ${what} to be defined`);
  return value;
}

/** The settings module keeps its state on globalThis (shared across `bun --hot` reloads); tests reset it between cases. */
export const settingsGlobal = () => globalThis as { __nightshiftSettings?: { current: unknown; listeners: Set<unknown> } };
