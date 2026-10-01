import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { removeTempDirs, tempDir, waitFor } from "./helpers.ts";

// The server runs as a child process: modules are shared between bun test files, and this suite
// needs its own NIGHTSHIFT_HOME and skills folder.
const tmp = tempDir("ns-persist-");
const home = join(tmp, "home");
const descFile = join(tmp, "desc.md");

// Minimal stand-in for `claude`: returns the description found in FAKE_DESC_FILE, card stays put.
const fake = join(tmp, "fake-claude.ts");
writeFileSync(
  fake,
  `#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { removeTempDirs, tempDir, waitFor } from "./helpers.ts";
const e = (o) => console.log(JSON.stringify(o));
e({ type: "system", subtype: "init", session_id: "s", model: "fake" });
e({ type: "result", is_error: false, session_id: "s", structured_output: { description: readFileSync(process.env.FAKE_DESC_FILE, "utf8"), move: "stay", summary: "ok" } });
`,
);
chmodSync(fake, 0o755);

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const proj = join(tmp, "proj");
const wt = join(tmp, "wt");
let srv: Bun.Subprocess<"ignore", "pipe", "inherit">;
let base = "";
let backlogId = "";
let workId = "";

const post = (path: string, body: object, method = "POST") =>
  fetch(base + path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
const snapshot = () => fetch(`${base}/api/project?project=${encodeURIComponent(proj)}`).then((r) => r.json());
const q = `project=${encodeURIComponent(proj)}`;
const shot = (id: string, file: string) => fetch(`${base}/api/cards/${id}/screenshot?${q}&file=${encodeURIComponent(file)}`);

/** Creates a card, lets the fake agent return `description`, and returns the card once the run ended. */
async function runAgent(description: string, existingId?: string) {
  writeFileSync(descFile, description);
  let id = existingId;
  if (id) {
    await post(`/api/cards/${id}/move`, { project: proj, columnId: backlogId });
    await post(`/api/cards/${id}/move`, { project: proj, columnId: workId });
  } else {
    id = (await post("/api/cards", { project: proj, columnId: workId, title: "shots" })).id as string;
  }
  const before = existingId ? (await snapshot()).board.cards.find((c: any) => c.id === id).lastRun?.at : undefined;
  await waitFor(async () => {
    const c = (await snapshot()).board.cards.find((c: any) => c.id === id);
    return !!c?.lastRun && c.lastRun.at !== before;
  });
  return { id, card: (await snapshot()).board.cards.find((c: any) => c.id === id) };
}

beforeAll(async () => {
  mkdirSync(join(proj, ".claude", "skills", "work"), { recursive: true });
  writeFileSync(join(proj, ".claude", "skills", "work", "SKILL.md"), "---\nname: work\ndescription: test\n---\n");
  mkdirSync(join(wt, "nightshift-screenshots"), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "settings.json"), JSON.stringify({ claudePath: fake, maxParallel: 2 }));
  srv = Bun.spawn(["bun", join(import.meta.dir, "..", "bin", "nightshift.ts"), "--no-open", "--port", "0"], {
    cwd: tmp,
    env: { ...process.env, NIGHTSHIFT_HOME: home, FAKE_DESC_FILE: descFile, NODE_ENV: "production" },
    stdout: "pipe",
    stderr: "inherit",
  });
  const decoder = new TextDecoder();
  let out = "";
  for await (const chunk of srv.stdout) {
    out += decoder.decode(chunk);
    const m = out.match(/running at http:\/\/localhost:(\d+)\//);
    if (m) {
      base = `http://localhost:${m[1]}`;
      break;
    }
  }
  if (!base) throw new Error("server did not start");
  const snap = await post("/api/projects/open", { path: proj });
  const [backlog, done] = snap.board.columns;
  backlogId = backlog.id;
  const res = await post("/api/board", { project: proj, columns: [backlog, { name: "Work", type: "skill", skill: "work" }, done] }, "PUT");
  workId = res.board.columns[1].id;
});
afterAll(() => {
  srv?.kill();
  removeTempDirs();
});

test("persist-copies-and-rewrites", async () => {
  const png = join(wt, "nightshift-screenshots", "01-a.png");
  writeFileSync(png, PNG);
  const { id, card } = await runAgent(`## Shots\n\n![A](${png})\n![again](${png})`);
  const copy = join(home, "screenshots", id, "01-a.png");
  expect(existsSync(copy)).toBe(true);
  expect(card.description).toBe(`## Shots\n\n![A](${copy})\n![again](${copy})`);
  rmSync(wt, { recursive: true, force: true });
  const res = await shot(id, copy);
  expect(res.status).toBe(200);
  expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true);
});

test("persist-overwrite-and-missing", async () => {
  mkdirSync(join(wt, "nightshift-screenshots"), { recursive: true });
  const png = join(wt, "nightshift-screenshots", "02-b.png");
  const gone = join(wt, "nightshift-screenshots", "03-gone.png");
  writeFileSync(png, PNG);
  const first = await runAgent(`![B](${png})`);
  const copy = join(home, "screenshots", first.id, "02-b.png");
  expect(readFileSync(copy).equals(PNG)).toBe(true);
  const modified = Buffer.concat([PNG, Buffer.from("x")]);
  writeFileSync(png, modified);
  const second = await runAgent(`![B](${png})\n![G](${gone})`, first.id);
  expect(readFileSync(copy).equals(modified)).toBe(true);
  expect(second.card.description).toBe(`![B](${copy})\n![G](${gone})`);
  expect(second.card.lastRun.status).toBe("success");
  // Idempotent: a path already in the stable dir is left alone.
  const third = await runAgent(second.card.description, first.id);
  expect(third.card.description).toBe(second.card.description);
});

test("screenshot-access-other-card", async () => {
  const dirB = join(home, "screenshots", "card_b");
  mkdirSync(dirB, { recursive: true });
  const copyB = join(dirB, "01-x.png");
  writeFileSync(copyB, PNG);
  const { id } = await runAgent(`![X](${copyB})`);
  expect(id).not.toBe("card_b");
  expect((await shot(id, copyB)).status).toBe(400);
});

test("delete-removes-screenshots", async () => {
  mkdirSync(join(wt, "nightshift-screenshots"), { recursive: true });
  const png = join(wt, "nightshift-screenshots", "04-d.png");
  writeFileSync(png, PNG);
  const { id } = await runAgent(`![D](${png})`);
  const dir = join(home, "screenshots", id);
  expect(existsSync(dir)).toBe(true);
  await post(`/api/cards/${id}`, { project: proj }, "DELETE");
  expect(existsSync(dir)).toBe(false);
});
