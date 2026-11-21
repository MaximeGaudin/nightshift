import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Card } from "../src/shared/types.ts";
import { makeFakeGh } from "./fake-gh.ts";
import { removeTempDirs, tempDir, waitFor } from "./helpers.ts";

// The server runs as a child process with its own NIGHTSHIFT_HOME, a fake `claude` and a fake `gh`.
const tmp = tempDir("ns-pr-run-");
const home = join(tmp, "home");
const outFile = join(tmp, "out.json");
const fake = join(tmp, "fake-claude.ts");
writeFileSync(
  fake,
  `#!/usr/bin/env bun
import { readFileSync } from "node:fs";
const e = (o) => console.log(JSON.stringify(o));
const out = JSON.parse(readFileSync(process.env.FAKE_OUT_FILE, "utf8"));
e({ type: "system", subtype: "init", session_id: "s", model: "fake" });
e({ type: "result", is_error: false, session_id: "s", structured_output: { ...out, summary: "ok" } });
`,
);
chmodSync(fake, 0o755);
const gh = makeFakeGh(tmp);

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const proj = join(tmp, "proj");
const wt = join(tmp, "wt");
const PR_URL = "https://github.test/o/r/pull/9";
let srv: Bun.Subprocess<"ignore", "pipe", "inherit">;
let base = "";
let workId = "";
let doneId = "";

const post = (path: string, body: object, method = "POST") =>
  fetch(base + path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
const q = `project=${encodeURIComponent(proj)}`;
const cardOf = async (id: string): Promise<Card> =>
  (await fetch(`${base}/api/project?${q}`).then((r) => r.json())).board.cards.find((c: Card) => c.id === id);
const logOf = async (id: string): Promise<string[]> =>
  ((await fetch(`${base}/api/cards/${id}/log?${q}`).then((r) => r.json())) as { text: string }[]).map((l) => l.text);

async function runCard(png: string, move: string) {
  writeFileSync(outFile, JSON.stringify({ description: `## Screenshots\n\n![Home](${png})`, move }));
  const id = (await post("/api/cards", { project: proj, columnId: workId, title: "shots" })).id as string;
  await waitFor(async () => !!(await cardOf(id))?.lastRun);
  return id;
}

beforeAll(async () => {
  mkdirSync(join(proj, ".claude", "skills", "work"), { recursive: true });
  writeFileSync(join(proj, ".claude", "skills", "work", "SKILL.md"), "---\nname: work\ndescription: test\n---\n");
  Bun.spawnSync(["git", "init", "-q"], { cwd: proj });
  mkdirSync(join(wt, "nightshift-screenshots"), { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "settings.json"), JSON.stringify({ claudePath: fake, maxParallel: 2 }));
  srv = Bun.spawn(["bun", join(import.meta.dir, "..", "bin", "nightshift.ts"), "--no-open", "--port", "0"], {
    cwd: tmp,
    env: { ...process.env, ...gh.env, NIGHTSHIFT_HOME: home, NIGHTSHIFT_GH: gh.bin, FAKE_OUT_FILE: outFile, NODE_ENV: "production" },
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
  const res = await post("/api/board", { project: proj, columns: [backlog, { name: "Work", type: "skill", skill: "work" }, done] }, "PUT");
  workId = res.board.columns[1].id;
  doneId = res.board.columns[2].id;
});
afterAll(() => {
  srv?.kill();
  removeTempDirs();
});

test("run-exclude-and-pr", async () => {
  gh.setState({ pr: { url: PR_URL, body: "PR body", state: "OPEN" }, release: null });
  const png = join(wt, "nightshift-screenshots", "01-home.png");
  writeFileSync(png, PNG);
  const id = await runCard(png, "stay");
  expect(readFileSync(join(proj, ".git", "info", "exclude"), "utf8")).toContain("nightshift-screenshots/\n");
  expect((await cardOf(id)).lastRun?.status).toBe("success");
  await waitFor(() => gh.calls().some((c) => c.args[0] === "pr" && c.args[1] === "edit"));
  const view = gh.calls().find((c) => c.args[1] === "view" && c.args[0] === "pr");
  expect(view?.args[2]).toBe(`nightshift/${id}`);
  const edit = gh.calls().find((c) => c.args[1] === "edit");
  expect(edit?.stdin).toContain(`![Home](https://github.test/o/r/releases/download/nightshift-screenshots/${id}-01-home.png)`);
  expect(edit?.stdin?.startsWith("PR body\n\n")).toBe(true);
});

test("run-gh-fails-card-ok", async () => {
  gh.setState({ pr: { url: PR_URL, body: "PR body", state: "OPEN" }, release: { assets: [] }, failUpload: true });
  const png = join(wt, "nightshift-screenshots", "02-home.png");
  writeFileSync(png, PNG);
  const id = await runCard(png, "next");
  const card = await cardOf(id);
  expect(card.lastRun?.status).toBe("success");
  expect(card.columnId).toBe(doneId);
  await waitFor(async () => (await logOf(id)).some((l) => l.startsWith("Screenshots non ajoutés à la PR")));
  expect(await logOf(id)).toContain("Screenshots non ajoutés à la PR : HTTP 422: upload refused");
  expect(gh.calls().some((c) => c.args[1] === "edit")).toBe(false);
});
