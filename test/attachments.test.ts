import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dragHasFiles, fileToBase64, insertAttachments } from "../src/web/attachments.ts";
import { type ChildServer, startChildServer } from "./helpers.ts";

// Own child process and NIGHTSHIFT_HOME: see helpers.ts.
let srv: ChildServer;
let dir = "";
let cardId = "";
const attach = (body: object, id = cardId) => srv.call(`/api/cards/${id}/attachments`, { body: { project: dir, ...body } });
const b64 = (s: string) => Buffer.from(s).toString("base64");

beforeAll(async () => {
  srv = await startChildServer({ agents: false });
  dir = mkdtempSync(join(srv.tmp, "proj-"));
  expect((await srv.call("/api/projects/open", { body: { path: dir } })).status).toBe(200);
  cardId = (await srv.call("/api/cards", { body: { project: dir, title: "with files" } }).then((r) => r.json())).id;
});
afterAll(() => srv?.stop());

test("attachments-upload stores the file and returns a markdown link to its absolute path", async () => {
  const r = await attach({ name: "../../spec v1.pdf", data: b64("hello") });
  expect(r.status).toBe(200);
  const { path, markdown } = await r.json();
  expect(path.startsWith(join(srv.tmp))).toBe(true);
  expect(path).toContain(join("attachments", cardId, "spec_v1.pdf"));
  expect(readFileSync(path, "utf8")).toBe("hello");
  expect(markdown).toBe(`[spec_v1.pdf](${path})`);

  const again = await attach({ name: "spec v1.pdf", data: b64("bye") }).then((x) => x.json());
  expect(again.path.endsWith("spec_v1-2.pdf")).toBe(true);
  expect(readFileSync(path, "utf8")).toBe("hello");
});

test("attachments-png images land in the screenshots folder and can be shown", async () => {
  const { path, markdown } = await attach({ name: "Shot.PNG", data: b64("png") }).then((r) => r.json());
  expect(path).toContain(join("screenshots", cardId, "Shot.png"));
  expect(markdown).toBe(`![Shot.png](${path})`);
  await srv.call(`/api/cards/${cardId}`, { method: "PATCH", body: { project: dir, description: markdown } });
  const shot = await srv.call(`/api/cards/${cardId}/screenshot?project=${encodeURIComponent(dir)}&file=${encodeURIComponent(path)}`);
  expect(shot.status).toBe(200);
});

test("attachments-validation refuses empty, non-base64, unknown cards", async () => {
  expect((await attach({ name: "a.txt", data: "" })).status).toBe(400);
  expect((await attach({ name: "a.txt", data: "not base64!" })).status).toBe(400);
  expect((await attach({ data: b64("x") })).status).toBe(400);
  expect((await attach({ name: "a.txt", data: b64("x") }, "card_nope")).status).toBe(404);
});

test("attachments-delete removes the card's files", async () => {
  const id = (await srv.call("/api/cards", { body: { project: dir, title: "gone" } }).then((r) => r.json())).id;
  const { path } = await attach({ name: "notes.md", data: b64("x") }, id).then((r) => r.json());
  expect(existsSync(path)).toBe(true);
  await srv.call(`/api/cards/${id}?project=${encodeURIComponent(dir)}`, { method: "DELETE" });
  expect(existsSync(path)).toBe(false);
});

test("insertAttachments puts each file on its own line at the caret or the end", () => {
  expect(insertAttachments("", ["[a](/a)"])).toBe("[a](/a)");
  expect(insertAttachments("intro", ["[a](/a)", "[b](/b)"])).toBe("intro\n[a](/a)\n[b](/b)");
  expect(insertAttachments("intro\n", ["[a](/a)"])).toBe("intro\n[a](/a)");
  expect(insertAttachments("ab", ["[x](/x)"], 1)).toBe("a\n[x](/x)\nb");
  expect(insertAttachments("a\nb", ["[x](/x)"], 2)).toBe("a\n[x](/x)\nb");
  expect(insertAttachments("same", [])).toBe("same");
});

test("dragHasFiles only accepts drags carrying files", () => {
  expect(dragHasFiles({ types: ["Files"] } as unknown as DataTransfer)).toBe(true);
  expect(dragHasFiles({ types: ["text/plain"] } as unknown as DataTransfer)).toBe(false);
  expect(dragHasFiles(null)).toBe(false);
});

test("fileToBase64 encodes the bytes", async () => {
  expect(await fileToBase64(new Blob(["héllo"]))).toBe(Buffer.from("héllo").toString("base64"));
});
