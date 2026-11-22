import { afterAll } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// bun test runs every file in one process with one module cache: settings.ts reads NIGHTSHIFT_HOME at import,
// skills.ts reads NIGHTSHIFT_USER_SKILLS at import, and startServer reuses globalThis.__nightshift. Any test that
// starts a server or touches settings either runs the server in a child process with its own NIGHTSHIFT_HOME,
// through this helper, or takes the home and user skills paths from the imported modules (NIGHTSHIFT_HOME from
// settings.ts, skillsDir("user", "") from skills.ts) instead of from the env vars it just set.

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

/**
 * Polls `fn` until it returns true. On timeout the error names the wait: `label` is a string, or a function whose
 * result (the state the test was waiting on) is serialized into the message.
 */
export async function waitFor(fn: () => Promise<boolean> | boolean, ms = 8000, label?: string | (() => unknown | Promise<unknown>)) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await Bun.sleep(25);
  }
  if (label === undefined) throw new Error("timeout");
  if (typeof label === "string") throw new Error(`timeout: ${label}`);
  let last: unknown;
  try {
    last = await label();
  } catch (e) {
    last = `(label failed: ${e})`;
  }
  throw new Error(`timeout after ${ms} ms, last state: ${JSON.stringify(last)}`);
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

/**
 * Snapshot of `globalThis.__nightshiftSettings` taken now: `restore()` puts back the very object found (modules already
 * in the cache captured it in `const shared`), so a file that resets the global to get a fresh settings.ts instance
 * never leaves `undefined` or a foreign object for the files that follow in the same `bun test` process.
 */
export function keepSettingsGlobal(): { restore(): void } {
  const saved = settingsGlobal().__nightshiftSettings;
  return {
    restore() {
      settingsGlobal().__nightshiftSettings = saved;
    },
  };
}

/**
 * Call at the top of a test file, BEFORE it sets any of `names` in `process.env`: registers an `afterAll` that puts
 * each variable back to the value it had now (deleted when it was unset), so the next file in the process sees the
 * environment it started with.
 */
export function restoreEnvAfterAll(...names: string[]) {
  const saved = names.map((name) => [name, process.env[name]] as const);
  afterAll(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

/** A fake `gh` (test/fake-gh.ts) in its own folder, with its JSON state and call log. Prepend `dir` to PATH to use it. */
export function installFakeGh(initial: Record<string, unknown> = { prs: [] }) {
  const dir = tempDir("ns-fake-gh-");
  const statePath = join(dir, "state.json");
  const logPath = join(dir, "calls.jsonl");
  const bin = join(dir, "gh");
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dir, "fake-gh.ts")}" "$@"\n`);
  chmodSync(bin, 0o755);
  writeFileSync(statePath, JSON.stringify(initial));
  return {
    dir,
    statePath,
    logPath,
    env: { FAKE_GH_STATE: statePath, FAKE_GH_LOG: logPath },
    // biome-ignore lint/suspicious/noExplicitAny: test state is free-form JSON
    state: (): any => JSON.parse(readFileSync(statePath, "utf8")),
    setState: (s: unknown) => writeFileSync(statePath, JSON.stringify(s)),
    calls: (): { args: string[]; stdin?: string }[] =>
      existsSync(logPath)
        ? readFileSync(logPath, "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((l) => JSON.parse(l))
        : [],
  };
}
