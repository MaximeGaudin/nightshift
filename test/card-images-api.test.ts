import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type ChildServer, startChildServer } from "./helpers.ts";

// Own child process and NIGHTSHIFT_HOME: see helpers.ts.
let srv: ChildServer;
let dir = "";
const proj = () => `project=${encodeURIComponent(dir)}`;
const folder = (id: string) => join(srv.home, "screenshots", id);
const files = (id: string) => (existsSync(folder(id)) ? readdirSync(folder(id)) : []);
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const withHeader = (head: number[] | string, size = 32) => {
  const out = new Uint8Array(size).fill(7);
  out.set(typeof head === "string" ? Array.from(head, (c) => c.charCodeAt(0)) : head);
  return out;
};
const PNG = withHeader([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = withHeader([0xff, 0xd8, 0xff, 0xe0]);
const GIF = withHeader("GIF89a");
const WEBP = (() => {
  const out = withHeader("RIFF");
  out.set(Array.from("WEBP", (c) => c.charCodeAt(0)), 8);
  return out;
})();

const newCard = async (title = "card") =>
  (await srv.call("/api/cards", { body: { project: dir, title } }).then((r) => r.json())).id as string;
const upload = (id: string, body: Record<string, unknown>) => srv.call(`/api/cards/${id}/images`, { body: { project: dir, ...body } });
const setDescription = (id: string, description: string) =>
  srv.call(`/api/cards/${id}`, { method: "PATCH", body: { project: dir, description } });

beforeAll(async () => {
  srv = await startChildServer({ agents: false });
  dir = mkdtempSync(join(srv.tmp, "proj-"));
  expect((await srv.call("/api/projects/open", { body: { path: dir } })).status).toBe(200);
});
afterAll(() => srv?.stop());

test("upload stores a PNG", async () => {
  const id = await newCard();
  const r = await upload(id, { data: b64(PNG) });
  expect(r.status).toBe(200);
  const { path } = await r.json();
  expect(path.startsWith(`${folder(id)}/paste-`)).toBe(true);
  expect(path.endsWith(".png")).toBe(true);
  expect(new Uint8Array(readFileSync(path))).toEqual(PNG);
});

test("upload keeps JPEG/GIF/WebP format", async () => {
  const id = await newCard();
  for (const [bytes, ext] of [
    [JPEG, ".jpg"],
    [GIF, ".gif"],
    [WEBP, ".webp"],
  ] as const) {
    const { path } = await upload(id, { data: b64(bytes) }).then((r) => r.json());
    expect(path.endsWith(ext)).toBe(true);
    expect(new Uint8Array(readFileSync(path))).toEqual(bytes);
  }
  expect(files(id)).toHaveLength(3);
});

test("upload rejects non-image", async () => {
  const id = await newCard();
  for (const data of [b64(new TextEncoder().encode("hello")), b64(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))]) {
    const r = await upload(id, { data });
    expect(r.status).toBe(415);
    expect((await r.json()).error).toContain("Unsupported image type");
  }
  for (const data of ["", "not base64!", 42]) expect((await upload(id, { data })).status).toBe(400);
  expect(files(id)).toEqual([]);
});

test("upload rejects > 8 MB", async () => {
  const id = await newCard();
  const r = await upload(id, { data: b64(withHeader([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 8 * 1024 * 1024 + 1)) });
  expect(r.status).toBe(413);
  expect((await r.json()).error).toContain("8 MB");
  expect(files(id)).toEqual([]);
});

test("upload unknown card", async () => {
  const r = await upload("card_nope", { data: b64(PNG) });
  expect(r.status).toBe(404);
  expect(existsSync(folder("card_nope"))).toBe(false);
});

test("upload ignores names", async () => {
  const id = await newCard();
  const { path } = await upload(id, { data: b64(PNG), name: "../../evil.png", file: "../../evil.png" }).then((r) => r.json());
  expect(path.startsWith(`${folder(id)}/paste-`)).toBe(true);
  expect(path).not.toContain("evil");
  expect(existsSync(join(folder(id), "../../evil.png"))).toBe(false);
  expect(existsSync(join(srv.home, "evil.png"))).toBe(false);
});

test("upload needs JSON", async () => {
  const id = await newCard();
  const r = await fetch(`${srv.base}/api/cards/${id}/images?${proj()}`, {
    method: "POST",
    headers: { "content-type": "image/png" },
    body: PNG,
  });
  expect(r.status).toBe(415);
  expect(files(id)).toEqual([]);
});

test("serve pasted image", async () => {
  const id = await newCard();
  const { path } = await upload(id, { data: b64(JPEG) }).then((r) => r.json());
  const { path: other } = await upload(id, { data: b64(GIF) }).then((r) => r.json());
  expect((await setDescription(id, `x\n![image](${path})\n`)).status).toBe(200);
  const r = await srv.call(`/api/cards/${id}/screenshot?${proj()}&file=${encodeURIComponent(path)}`);
  expect(r.status).toBe(200);
  expect(r.headers.get("content-type")).toBe("image/jpeg");
  expect(new Uint8Array(await r.arrayBuffer())).toEqual(JPEG);
  const refused = await srv.call(`/api/cards/${id}/screenshot?${proj()}&file=${encodeURIComponent(other)}`);
  expect(refused.status).toBeGreaterThanOrEqual(400);
  expect(refused.status).toBeLessThan(500);
});

test("delete card removes pasted images", async () => {
  const id = await newCard();
  await upload(id, { data: b64(PNG) });
  expect(files(id)).toHaveLength(1);
  expect((await srv.call(`/api/cards/${id}?${proj()}`, { method: "DELETE" })).status).toBe(200);
  expect(existsSync(folder(id))).toBe(false);
});
