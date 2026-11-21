import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DESCRIPTION_CHANGED, DESCRIPTION_UNCHANGED } from "../src/server/orchestrator.ts";
import type { Card, Column } from "../src/shared/types.ts";
import { type ChildServer, must, removeTempDirs, startChildServer, tempDir, waitFor } from "./helpers.ts";

let srv: ChildServer;
let argsLog: string;
beforeAll(async () => {
  const tmp = tempDir("ns-seen-");
  argsLog = join(tmp, "args.jsonl");
  srv = await startChildServer({
    agents: true,
    settings: { claudePath: join(import.meta.dir, "fake-claude.ts") },
    env: { FAKE_DELAY_MS: "50", FAKE_ARGS_LOG: argsLog },
  });
  mkdirSync(join(srv.skills, "enrich"), { recursive: true });
  writeFileSync(join(srv.skills, "enrich", "SKILL.md"), "---\nname: enrich\ndescription: test\n---\n");
}, 30000);
afterAll(async () => {
  await srv.stop();
  removeTempDirs();
});

interface RunLine {
  title: string;
  resumed: boolean;
  continuing: boolean;
  resumeId: string | null;
  prompt: string;
}
const runsOf = (title: string): RunLine[] =>
  (() => {
    try {
      return readFileSync(argsLog, "utf8").trim().split("\n");
    } catch {
      return [];
    }
  })()
    .filter(Boolean)
    .map((l) => JSON.parse(l) as RunLine)
    .filter((r) => r.title.startsWith(title));

const long = (tag: string) => `${tag} `.repeat(30).trim();
const NOTE = `## Brief\n\n${long("brief")}\n\n## Tasks\n\n${long("tasks")}\n\n## Tests\n\n${long("tests")}`;

/** Columns A (skill), Hold (inert), B (skill, in `mode`), Done. The card is created in A with NOTE and stops in Hold. */
async function setup(title: string, mode: Column["freshSession"] | "absent" = "absent") {
  const dir = mkdtempSync(join(srv.tmp, "proj-"));
  await srv.call("/api/projects/open", { body: { path: dir } });
  const res = await srv
    .call("/api/board", {
      method: "PUT",
      body: {
        project: dir,
        columns: [
          { name: "A", type: "skill", skill: "enrich" },
          { name: "Hold", type: "inert" },
          { name: "B", type: "skill", skill: "enrich", ...(mode === "absent" ? {} : { freshSession: mode }) },
          { name: "Done", type: "inert" },
        ],
      },
    })
    .then((r) => r.json());
  const cols = res.board.columns as Column[];
  const col = (n: string) =>
    must(
      cols.find((c) => c.name === n),
      n,
    );
  const { id } = await srv
    .call("/api/cards", { body: { project: dir, columnId: col("A").id, title, description: NOTE } })
    .then((r) => r.json());
  const snap = async () => {
    const s = await srv.call(`/api/project?project=${encodeURIComponent(dir)}`).then((r) => r.json());
    return s.board.cards.find((c: Card) => c.id === id) as Card;
  };
  const saved = () => (JSON.parse(readFileSync(join(dir, "nightshift.json"), "utf8")).cards as Card[]).find((c) => c.id === id) as Card;
  const reach = (n: string) => waitFor(async () => (await snap()).columnId === col(n).id && !!(await snap()).lastRun, 15000);
  await reach("Hold");
  const toB = async () => {
    await srv.call(`/api/cards/${id}/move`, { body: { project: dir, columnId: col("B").id } });
    await reach("Done");
  };
  return { dir, id, snap, saved, toB };
}

test("run-continue-unchanged: the next column continuing the session gets the unchanged sentence, not the note", async () => {
  const t = await setup("same FAKE_KEEP_DESC");
  expect(t.saved().seenDescription).toEqual({ sessionId: "sess-1", text: NOTE });
  await t.toB();
  const [a, b] = runsOf("same FAKE_KEEP_DESC");
  expect(a?.continuing).toBe(false);
  expect(a?.prompt).toContain(`<description>\n${NOTE}\n</description>`);
  expect(b?.continuing).toBe(true);
  expect(b?.resumeId).toBe("sess-1");
  expect(b?.prompt).toContain(DESCRIPTION_UNCHANGED);
  expect(b?.prompt).not.toContain(long("brief"));
}, 30000);

test("run-continue-human-edit: a section edited between columns is the only one sent", async () => {
  const t = await setup("edited FAKE_KEEP_DESC");
  const edited = NOTE.replace(long("tasks"), "tasks edited by a human");
  await srv.call(`/api/cards/${t.id}`, { method: "PATCH", body: { project: t.dir, description: edited } });
  await t.toB();
  const b = runsOf("edited FAKE_KEEP_DESC")[1];
  expect(b?.continuing).toBe(true);
  expect(b?.prompt).toContain(
    `<description-changes>\n${DESCRIPTION_CHANGED}\n\n## Tasks\n\ntasks edited by a human\n</description-changes>`,
  );
  expect(b?.prompt).not.toContain(long("brief"));
  expect(b?.prompt).not.toContain(long("tests"));
  expect(t.saved().seenDescription).toEqual({ sessionId: "sess-1", text: edited });
}, 30000);

test("run-fresh-session: a column starting a fresh session gets the whole note", async () => {
  const t = await setup("fresh FAKE_KEEP_DESC", true);
  await t.toB();
  const b = runsOf("fresh FAKE_KEEP_DESC")[1];
  expect(b?.continuing).toBe(false);
  expect(b?.prompt).toContain(`<description>\n${NOTE}\n</description>`);
  expect(b?.prompt).not.toContain(DESCRIPTION_UNCHANGED);
}, 30000);

test("run-unknown-session-fallback: a session that cannot be resumed is retried with the whole note", async () => {
  const t = await setup("gone FAKE_UNKNOWN_SESSION FAKE_KEEP_DESC");
  // Pretend the card's session lives on another machine: the reduced prompt is sent, then the fallback.
  const file = join(t.dir, "nightshift.json");
  const board = JSON.parse(readFileSync(file, "utf8"));
  const card = board.cards.find((c: Card) => c.id === t.id);
  card.sessionId = "sess-deleted";
  card.seenDescription = { sessionId: "sess-deleted", text: NOTE };
  card.lastRun.sessionId = "sess-deleted";
  writeFileSync(file, JSON.stringify(board, null, 2));
  await waitFor(async () => (await t.snap()).sessionId === "sess-deleted", 10000);
  await t.toB();
  const [, first, retry] = runsOf("gone FAKE_UNKNOWN_SESSION");
  expect(first?.continuing).toBe(true);
  expect(first?.resumeId).toBe("sess-deleted");
  expect(first?.prompt).toContain(DESCRIPTION_UNCHANGED);
  expect(retry?.resumeId).toBeNull();
  expect(retry?.prompt.startsWith("New step for this card.")).toBe(false);
  expect(retry?.prompt).toContain(`<description>\n${NOTE}\n</description>`);
  expect(t.saved().seenDescription).toEqual({ sessionId: "sess-1", text: NOTE });
}, 30000);

test("run-snapshot-after-sections: the snapshot is the note after the run's own section edits", async () => {
  const t = await setup("FAKE_SECTIONS");
  const card = await t.snap();
  expect(card.description).toBe(`${NOTE}\n\n## Result\n\ndone by fake`);
  expect(t.saved().seenDescription).toEqual({ sessionId: "sess-1", text: card.description });
}, 30000);

test("run-feedback-reduced: feedback on the session that saw the note only sends what changed", async () => {
  const t = await setup("feedback FAKE_KEEP_DESC");
  const edited = `${NOTE}\n\n## Notes\n\nadded by a human`;
  await srv.call(`/api/cards/${t.id}`, { method: "PATCH", body: { project: t.dir, description: edited } });
  await srv.call(`/api/cards/${t.id}/feedback`, { body: { project: t.dir, text: "please FAKE_MOVE=stay" } });
  const feedbackRun = () => runsOf("feedback FAKE_KEEP_DESC").find((r) => r.resumed);
  await waitFor(() => !!feedbackRun(), 15000);
  const run = must(feedbackRun(), "feedback run");
  expect(run.resumeId).toBe("sess-1");
  expect(run.prompt).toContain(`<description-changes>\n${DESCRIPTION_CHANGED}\n\n## Notes\n\nadded by a human\n</description-changes>`);
  expect(run.prompt).not.toContain(long("brief"));
}, 30000);
