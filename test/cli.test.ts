import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openBrowser, parseArgs } from "../src/server/cli.ts";

test("cli-port-invalid: bad ports are refused", () => {
  expect(() => parseArgs(["--port", "abc"], {})).toThrow("Invalid port: abc");
  expect(() => parseArgs(["--port"], {})).toThrow("Invalid port");
  expect(() => parseArgs(["-p", "70000"], {})).toThrow("Invalid port: 70000");
  expect(() => parseArgs(["--port", "1.5"], {})).toThrow("Invalid port");
  expect(() => parseArgs(["--port", "-1"], {})).toThrow("Invalid port");
  expect(() => parseArgs([], { PORT: "abc" })).toThrow("Invalid port: abc");
  expect(() => parseArgs(["--foo"], {})).toThrow("Unknown option");
});

test("cli-port-invalid: e2e exits 2 with message on stderr", async () => {
  const p = Bun.spawn(["bun", join(import.meta.dir, "../bin/nightshift.ts"), "--port", "abc", "--no-open", "--no-agents"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const err = await new Response(p.stderr).text();
  expect(await p.exited).toBe(2);
  expect(err).toContain("Invalid port: abc");
});

test("cli-port-valid: defaults and explicit ports", () => {
  expect(parseArgs(["--port", "0"], {}).port).toBe(0);
  expect(parseArgs([], {}).port).toBe(4545);
  expect(parseArgs([], { PORT: "" }).port).toBe(4545);
  expect(parseArgs([], { PORT: "0" }).port).toBe(0);
  expect(parseArgs(["-p", "65535"], { PORT: "1" }).port).toBe(65535);
  const o = parseArgs(["/tmp/x", "--no-open", "--no-agents"], {});
  expect(o).toMatchObject({ dir: "/tmp/x", open: false, agents: false });
});

test("cli-browser-missing: a missing browser opener does not throw", () => {
  const errors: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => void errors.push(a.join(" "));
  try {
    expect(openBrowser("http://localhost:1/", "nightshift-no-such-opener")).toBe(false);
  } finally {
    console.error = orig;
  }
  expect(errors.join("\n")).toContain("Could not open the browser");
});

test("cli-sighup: SIGHUP shuts down cleanly", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "ns-cli-"));
  try {
    const p = Bun.spawn([process.execPath, join(import.meta.dir, "../bin/nightshift.ts"), "--port", "0", "--no-open", "--no-agents", tmp], {
      env: { ...process.env, NIGHTSHIFT_HOME: join(tmp, "home"), NODE_ENV: "production" },
      stdout: "pipe",
      stderr: "inherit",
    });
    const decoder = new TextDecoder();
    let out = "";
    for await (const chunk of p.stdout) {
      out += decoder.decode(chunk);
      if (out.includes("Nightshift running")) break;
    }
    p.kill("SIGHUP");
    expect(await p.exited).toBe(0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
