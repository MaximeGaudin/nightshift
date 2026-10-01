import { afterAll, beforeAll, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { removeTempDirs, tempDir } from "./helpers.ts";

// The server runs as a child process: bun test files share one module cache and one orchestrator, and this suite
// needs its own NIGHTSHIFT_HOME. The child prints the bound address once startServer returned.
const tmp = tempDir("ns-sec-");
const script = join(tmp, "serve.ts");
writeFileSync(
  script,
  `import { startServer } from ${JSON.stringify(join(import.meta.dir, "..", "src", "server", "server.ts"))};
const { server } = startServer({ port: 0, agents: false });
console.log(JSON.stringify({ port: server.port, hostname: server.hostname }));
`,
);

let child: Bun.Subprocess<"ignore", "pipe", "inherit">;
let port = 0;
let hostname = "";
let base = "";

beforeAll(async () => {
  child = Bun.spawn(["bun", script], {
    cwd: tmp,
    env: { ...process.env, NIGHTSHIFT_HOME: join(tmp, "home"), NIGHTSHIFT_USER_SKILLS: join(tmp, "skills"), NODE_ENV: "production" },
    stdout: "pipe",
    stderr: "inherit",
  });
  const decoder = new TextDecoder();
  let out = "";
  for await (const chunk of child.stdout) {
    out += decoder.decode(chunk);
    if (out.includes("\n")) break;
  }
  ({ port, hostname } = JSON.parse(out));
  base = `http://localhost:${port}`;
});
afterAll(() => {
  child?.kill();
  removeTempDirs();
});

const claudePath = () => fetch(`${base}/api/settings`).then((r) => r.json().then((s) => s.claudePath));

test("server-security-bind listens on 127.0.0.1 only", () => {
  expect(hostname).toBe("127.0.0.1");
});

test("server-security-csrf text/plain PUT is refused and changes nothing", async () => {
  const before = await claudePath();
  const res = await fetch(`${base}/api/settings`, {
    method: "PUT",
    headers: { "content-type": "text/plain" },
    body: '{"claudePath":"/tmp/x"}',
  });
  expect(res.status).toBe(415);
  expect(await claudePath()).toBe(before);
});

test("server-security-csrf cross-origin JSON PUT is refused", async () => {
  const before = await claudePath();
  const res = await fetch(`${base}/api/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json", origin: "http://evil.com" },
    body: '{"claudePath":"/tmp/x"}',
  });
  expect(res.status).toBe(403);
  expect(await claudePath()).toBe(before);
});

test("server-security-csrf same-origin JSON PUT still works", async () => {
  const before = await claudePath();
  const put = (claudePath: string) =>
    fetch(`${base}/api/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ claudePath }),
    });
  expect((await put("/tmp/x")).status).toBe(200);
  expect(await claudePath()).toBe("/tmp/x");
  await put(before);
});

test("server-security-rebinding foreign Host cannot list the disk", async () => {
  const res = await fetch(`${base}/api/fs`, { headers: { host: `attacker.example:${port}` } });
  expect(res.status).toBe(403);
  expect(await res.json()).toEqual({ error: "Forbidden host" });
  expect((await fetch(`${base}/api/fs`)).status).toBe(200);
});

test("server-security-rebinding /api/fs error does not leak the path", async () => {
  const res = await fetch(`${base}/api/fs?dir=${encodeURIComponent("/nonexistent-ns-dir")}`);
  expect(res.status).toBe(400);
  expect(JSON.stringify(await res.json())).not.toContain("nonexistent-ns-dir");
});

const openWs = (headers?: Record<string, string>) =>
  new Promise<{ ok: boolean; first?: any }>((resolve) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws`, headers ? ({ headers } as any) : undefined);
    ws.addEventListener("message", (e) => {
      resolve({ ok: true, first: JSON.parse(String(e.data)) });
      ws.close();
    });
    ws.addEventListener("close", () => resolve({ ok: false }));
    ws.addEventListener("error", () => resolve({ ok: false }));
  });

test("server-security-ws refuses a foreign origin", async () => {
  expect((await openWs({ origin: "http://evil.com" })).ok).toBe(false);
});

test("server-security-ws accepts no origin and the server origin; first message is settings", async () => {
  for (const h of [undefined, { origin: `http://localhost:${port}` }]) {
    const r = await openWs(h);
    expect(r.ok).toBe(true);
    expect(r.first.type).toBe("settings");
  }
});
