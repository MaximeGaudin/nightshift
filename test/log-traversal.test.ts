import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ChildServer, startChildServer } from "./helpers.ts";

let srv: ChildServer;
let project = "";

beforeAll(async () => {
  srv = await startChildServer();
  project = mkdtempSync(join(srv.tmp, "proj-"));
  await srv.call("/api/projects/open", { body: { path: project } });
});
afterAll(() => srv.stop());

test("log-traversal: card id with ../ does not read .jsonl outside the logs dir", async () => {
  mkdirSync(srv.home, { recursive: true });
  writeFileSync(join(srv.home, "secret.jsonl"), `${JSON.stringify({ at: "x", kind: "text", text: "TOPSECRET" })}\n`);
  const res = await srv.call(`/api/cards/..%2F..%2Fsecret/log?project=${encodeURIComponent(project)}`);
  expect(await res.text()).not.toContain("TOPSECRET");
});

test("log-traversal: reading a log creates no directory", async () => {
  await srv.call(`/api/cards/nope/log?project=${encodeURIComponent(project)}`);
  await srv.call(`/api/cards/..%2F..%2Fx/log?project=${encodeURIComponent(project)}`);
  expect(existsSync(join(srv.home, "logs"))).toBe(false);
});
