import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Card, LogLine } from "../src/shared/types.ts";
import { removeTempDirs, tempDir, waitFor } from "./helpers.ts";

process.env.NIGHTSHIFT_HOME = tempDir("ns-home-");
process.env.NIGHTSHIFT_USER_SKILLS = tempDir("ns-skills-");
const argsLog = join(tempDir("ns-args-"), "args.jsonl");
const prevArgsLog = process.env.FAKE_ARGS_LOG;
process.env.FAKE_ARGS_LOG = argsLog;

const { skillsDir } = await import("../src/server/skills.ts");
const { startServer } = await import("../src/server/server.ts");
const { updateSettings } = await import("../src/server/settings.ts");
const userSkills = skillsDir("user", "");

let srv: ReturnType<typeof startServer>;
let base = "";

beforeAll(() => {
  updateSettings({ claudePath: join(import.meta.dir, "fake-claude.ts"), maxParallel: 2, model: "settings-model" });
  srv = startServer({ port: 0 });
  base = `http://localhost:${srv.server.port}`;
  for (const name of ["nightshift-plan", "nightshift-implement", "nightshift-review"]) {
    mkdirSync(join(userSkills, name), { recursive: true });
    writeFileSync(join(userSkills, name, "SKILL.md"), `---\nname: ${name}\ndescription: test\n---\n`);
  }
});
afterAll(async () => {
  delete process.env.FAKE_DELAY_MS;
  delete process.env.FAKE_EXTRA_OUTPUT;
  await srv.orch.shutdown();
  srv.server.stop(true);
  if (prevArgsLog === undefined) delete process.env.FAKE_ARGS_LOG;
  else process.env.FAKE_ARGS_LOG = prevArgsLog;
  removeTempDirs();
});

const post = (path: string, body: object, method = "POST") =>
  fetch(base + path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());

const runs = (): { title: string; model: string | null; argv: string[] }[] =>
  readFileSync(argsLog, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

async function setup() {
  const dir = tempDir("ns-models-int-");
  const snap = await post("/api/projects/open", { path: dir });
  const backlog = snap.board.columns[0];
  const done = snap.board.columns.at(-1);
  const res = await post(
    "/api/board",
    {
      project: dir,
      columns: [
        backlog,
        { name: "Plan", type: "skill", skill: "nightshift-plan" },
        { name: "Implement", type: "skill", skill: "nightshift-implement" },
        { name: "Review", type: "skill", skill: "nightshift-review", model: "column-model" },
        done,
      ],
    },
    "PUT",
  );
  const get = async () =>
    (await fetch(`${base}/api/project?project=${encodeURIComponent(dir)}`).then((r) => r.json())).board.cards as Card[];
  const logOf = (id: string): Promise<LogLine[]> =>
    fetch(`${base}/api/cards/${id}/log?project=${encodeURIComponent(dir)}`).then((r) => r.json());
  return { dir, cols: res.board.columns as { id: string }[], get, logOf };
}

test("card models integration", async () => {
  process.env.FAKE_EXTRA_OUTPUT = JSON.stringify({ models: { "nightshift-implement": "haiku" }, move: "next" });
  const { dir, cols, get, logOf } = await setup();
  const { id } = await post("/api/cards", { project: dir, columnId: cols[1].id, title: "integ" });
  process.env.FAKE_DELAY_MS = "500"; // long enough to read the implement run's log (it is reset by each run)
  // Plan -> Implement -> Review -> Done, all with move "next".
  let implStart = "";
  await waitFor(async () => {
    // Implement continues the card's session from Plan: its start line says so.
    const l = (await logOf(id)).find((x) => x.text.includes('skill "nightshift-implement"'));
    if (l) implStart = l.text;
    return !!l;
  }, 15000);
  await waitFor(async () => (await get()).find((c) => c.id === id)?.columnId === cols[4].id, 15000);
  const card = (await get()).find((c) => c.id === id) as Card;
  expect(card.models).toEqual({ "nightshift-implement": "haiku" });

  const all = runs().filter((r) => r.title.startsWith("integ"));
  expect(all).toHaveLength(3);
  // Plan: no card entry, settings model. Implement: card entry. Review: column model.
  expect(all[0].model).toBe("settings-model");
  expect(all[1].model).toBe("haiku");
  expect(all[2].model).toBe("column-model");

  expect(implStart).toContain("model: haiku (card)");
});

test("invalid model never reaches argv", async () => {
  process.env.FAKE_EXTRA_OUTPUT = JSON.stringify({
    models: { "nightshift-implement": "opus --dangerously-skip-permissions" },
    move: "next",
  });
  const { dir, cols, get } = await setup();
  const { id } = await post("/api/cards", { project: dir, columnId: cols[1].id, title: "evil" });
  await waitFor(async () => (await get()).find((c) => c.id === id)?.columnId === cols[4].id, 15000);
  const card = (await get()).find((c) => c.id === id) as Card;
  expect(card.models).toBeUndefined();
  const mine = runs().filter((r) => r.title.startsWith("evil"));
  expect(mine).toHaveLength(3);
  expect(mine[1].model).toBe("settings-model");
  for (const r of mine) expect(r.argv.join(" ")).not.toContain("dangerously-skip-permissions");
});
