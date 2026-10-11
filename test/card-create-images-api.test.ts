import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pendingMarker } from "../src/shared/pendingImages.ts";
import type { Card, Column, ProjectSnapshot } from "../src/shared/types.ts";
import { type ChildServer, must, removeTempDirs, startChildServer, tempDir, waitFor } from "./helpers.ts";

setDefaultTimeout(20_000);

const PNG = (() => {
  const out = new Uint8Array(32).fill(7);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.from(out).toString("base64");
})();
const JUNK = Buffer.from(new Uint8Array(32).fill(1)).toString("base64");

// Stand-in for `claude` that records each prompt it gets, then moves the card on.
const tmp = tempDir("ns-create-images-");
const prompts = join(tmp, "prompts");
mkdirSync(prompts);
const fake = join(tmp, "fake-claude.ts");
writeFileSync(
  fake,
  `#!/usr/bin/env bun
const prompt = await new Response(Bun.stdin.stream()).text();
await Bun.write(${JSON.stringify(prompts)} + "/" + Date.now() + "-" + Math.random() + ".txt", prompt);
const e = (o) => console.log(JSON.stringify(o));
e({ type: "system", subtype: "init", session_id: "s-" + Math.random(), model: "fake" });
e({ type: "result", is_error: false, session_id: "s", structured_output: { move: "stay", summary: "ok" } });
`,
);
chmodSync(fake, 0o755);

const columns: Column[] = [
  { id: "col_backlog", name: "Backlog", type: "inert" },
  { id: "col_grill", name: "Grill", type: "skill", skill: "enrich", maxParallel: 3 },
  { id: "col_done", name: "Done", type: "inert" },
];

let srv: ChildServer;
let dir = "";
const q = () => `project=${encodeURIComponent(dir)}`;
const folder = (id: string) => join(srv.home, "screenshots", id);
const files = (id: string) => (existsSync(folder(id)) ? readdirSync(folder(id)) : []);
const snap = async (): Promise<ProjectSnapshot> => srv.call(`/api/project?${q()}`).then((r) => r.json());
const find = async (id: string): Promise<Card> =>
  must(
    (await snap()).board.cards.find((c) => c.id === id),
    "card",
  );
const create = (body: Record<string, unknown>) => srv.call("/api/cards", { body: { project: dir, title: "card", ...body } });

beforeAll(async () => {
  srv = await startChildServer({ agents: true, settings: { claudePath: fake } });
  mkdirSync(join(srv.skills, "enrich"), { recursive: true });
  writeFileSync(join(srv.skills, "enrich", "SKILL.md"), "---\nname: enrich\ndescription: test\n---\n");
  dir = mkdtempSync(join(srv.tmp, "proj-"));
  expect((await srv.call("/api/projects/open", { body: { path: dir } })).status).toBe(200);
  expect((await srv.call("/api/board", { method: "PUT", body: { project: dir, columns } })).status).toBe(200);
});
afterAll(async () => {
  await srv?.stop();
  removeTempDirs();
});

test("create-images-success", async () => {
  const r = await create({ description: `txt\n${pendingMarker(1)}`, images: { "1": PNG } });
  expect(r.status).toBe(200);
  const out = await r.json();
  expect(out.imageErrors).toBeUndefined();
  const [file] = files(out.id);
  expect(file).toMatch(/^paste-.*\.png$/);
  expect((await find(out.id)).description).toBe(`txt\n![image](${join(folder(out.id), file as string)})`);
});

test("create-images-partial-failure", async () => {
  const r = await create({ description: `a\n${pendingMarker(1)}\n${pendingMarker(2)}\nb`, images: { "1": PNG, "2": JUNK } });
  expect(r.status).toBe(200);
  const out = await r.json();
  expect(out.imageErrors).toHaveLength(1);
  const stored = files(out.id);
  expect(stored).toHaveLength(1);
  expect((await find(out.id)).description).toBe(`a\n![image](${join(folder(out.id), stored[0] as string)})\nb`);
});

test("create-images-orphans-ignored", async () => {
  const out = await (await create({ description: `a\n${pendingMarker(3)}\nb`, images: { "1": PNG } })).json();
  expect(files(out.id)).toEqual([]);
  expect((await find(out.id)).description).toBe("a\nb");
});

test("create-images-bad-shape", async () => {
  const before = (await snap()).board.cards.length;
  const many = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [String(i + 1), PNG]));
  for (const images of [[PNG], { "0": PNG }, { x: PNG }, { "1": 42 }, many]) {
    expect((await create({ description: pendingMarker(1), images })).status).toBe(400);
  }
  expect((await snap()).board.cards.length).toBe(before);
});

test("create-images-never-pending", async () => {
  expect((await srv.call("/api/flow/fast-forward/on", { body: { project: dir } })).status).toBe(200);
  const out = await (await create({ title: "ff", description: `go\n${pendingMarker(1)}`, images: { "1": PNG } })).json();
  await waitFor(async () => (await find(out.id)).columnId === "col_grill");
  await waitFor(async () => readdirSync(prompts).some((f) => readFileSync(join(prompts, f), "utf8").includes(out.id)));
  const prompt = readdirSync(prompts)
    .map((f) => readFileSync(join(prompts, f), "utf8"))
    .find((p) => p.includes(out.id));
  expect(prompt).toContain(folder(out.id));
  expect(prompt).not.toContain("pending:");
  expect((await find(out.id)).description).not.toContain("pending:");
  await srv.call("/api/flow/fast-forward/off", { body: { project: dir } });
});
