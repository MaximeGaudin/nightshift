import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { type ChildServer, startChildServer } from "./helpers.ts";

// Own child process and NIGHTSHIFT_HOME: see helpers.ts.
let srv: ChildServer;
let dir = "";
const proj = () => `project=${encodeURIComponent(dir)}`;
const snapshot = () => srv.call(`/api/project?${proj()}`).then((r) => r.json());
const raw = (path: string, method: string, body: string) =>
  fetch(srv.base + path, { method, headers: { "content-type": "application/json" }, body });

beforeAll(async () => {
  srv = await startChildServer({ agents: false });
  dir = mkdtempSync(join(srv.tmp, "proj-"));
  const r = await srv.call("/api/projects/open", { body: { path: dir } });
  expect(r.status).toBe(200);
});
afterAll(() => srv?.stop());

test("routes-invalid-json malformed body is a 400 and creates nothing", async () => {
  const r = await raw("/api/cards", "POST", "{oops");
  expect(r.status).toBe(400);
  expect((await r.json()).error).toBe("Invalid JSON body");
  const withProject = await raw("/api/cards", "POST", `{"project":${JSON.stringify(dir)}, oops`);
  expect(withProject.status).toBe(400);
  expect((await snapshot()).board.cards).toHaveLength(0);
});

test("routes-invalid-json non-object bodies are refused, empty body is accepted", async () => {
  for (const body of ["[]", "42", "null", '"x"']) expect((await raw("/api/cards", "POST", body)).status).toBe(400);
  // Empty body is {}: the handler runs.
  expect((await raw("/api/settings", "PUT", "")).status).toBe(200);
  expect((await snapshot()).board.cards).toHaveLength(0);
});
