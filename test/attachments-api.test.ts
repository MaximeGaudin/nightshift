import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type ChildServer, startChildServer } from "./helpers.ts";

// Own child process and NIGHTSHIFT_HOME: see helpers.ts.
let srv: ChildServer;
let dir = "";
const b64 = (s: string | Uint8Array) => Buffer.from(s).toString("base64");
const newCard = async (title = "card") =>
  (await srv.call("/api/cards", { body: { project: dir, title } }).then((r) => r.json())).id as string;
const attach = (id: string, body: Record<string, unknown>) => srv.call(`/api/cards/${id}/attachments`, { body: { project: dir, ...body } });
const folder = (id: string) => join(srv.home, "attachments", id);

beforeAll(async () => {
  srv = await startChildServer({ agents: false });
  dir = mkdtempSync(join(srv.tmp, "proj-"));
  expect((await srv.call("/api/projects/open", { body: { path: dir } })).status).toBe(200);
});
afterAll(() => srv?.stop());

test("attachments-api-store", async () => {
  const id = await newCard();
  const r = await attach(id, { name: "../../spec v1.pdf", data: b64("hello") });
  expect(r.status).toBe(200);
  const first = await r.json();
  expect(first).toEqual({ path: join(folder(id), "spec_v1.pdf"), name: "spec_v1.pdf" });
  expect(readFileSync(first.path, "utf8")).toBe("hello");

  const again = await (await attach(id, { name: "spec v1.pdf", data: b64("bye") })).json();
  expect(again).toEqual({ path: join(folder(id), "spec_v1-2.pdf"), name: "spec_v1-2.pdf" });
  expect(readFileSync(first.path, "utf8")).toBe("hello");
  expect(readFileSync(again.path, "utf8")).toBe("bye");
});

test("attachments-api-validation", async () => {
  const id = await newCard();
  expect((await attach(id, { name: "a.txt", data: "" })).status).toBe(400);
  expect((await attach(id, { name: "a.txt", data: "not base64!" })).status).toBe(400);
  expect((await attach(id, { name: "a.txt" })).status).toBe(400);
  expect((await attach(id, { data: b64("x") })).status).toBe(400);
  expect((await attach("card_nope", { name: "a.txt", data: b64("x") })).status).toBe(404);
  const big = b64(new Uint8Array(20 * 1024 * 1024 + 3));
  expect((await attach(id, { name: "big.bin", data: big })).status).toBe(413);
  expect(existsSync(folder(id)) ? readdirSync(folder(id)) : []).toEqual([]);
});

test("attachments-api-delete", async () => {
  const id = await newCard("gone");
  const { path } = await (await attach(id, { name: "notes.md", data: b64("x") })).json();
  expect(existsSync(path)).toBe(true);
  await srv.call(`/api/cards/${id}?project=${encodeURIComponent(dir)}`, { method: "DELETE" });
  expect(existsSync(folder(id))).toBe(false);
});
