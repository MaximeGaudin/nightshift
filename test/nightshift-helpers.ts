import { afterAll } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Card, Column } from "../src/shared/types.ts";
import { removeTempDirs, restoreEnvAfterAll, tempDir, waitFor } from "./helpers.ts";

/** An mtime long ago: a file that is rewritten gets a later one. */
export const PAST = new Date("2020-01-01T00:00:00Z");

/**
 * Shared setup of the test/nightshift-*.test.ts files. Each of those files calls `nightshiftEnv()` (or
 * `startNightshiftServer()`, which calls it) at its top level, BEFORE it imports any server module, and imports the
 * modules it needs after that with `await import(...)`. This module never imports a server module itself.
 *
 * bun test shares one module cache across files: settings.ts and skills.ts capture NIGHTSHIFT_HOME and
 * NIGHTSHIFT_USER_SKILLS once, at the first import. If another file (e.g. progress-prompts.test.ts, through
 * orchestrator.ts) imported them first, the paths set here are ignored. So the home and the user skills directory
 * used by a file are read back from the modules (`NIGHTSHIFT_HOME` of settings.ts, `skillsDir("user", "")` of
 * skills.ts), never from the variables set here.
 *
 * Variables restored and temp directories removed after the file's last test.
 */
export function nightshiftEnv() {
  restoreEnvAfterAll("NIGHTSHIFT_HOME", "NIGHTSHIFT_USER_SKILLS", "FAKE_ARGS_LOG", "FAKE_DELAY_MS");
  process.env.NIGHTSHIFT_HOME = tempDir("ns-home-");
  process.env.NIGHTSHIFT_USER_SKILLS = tempDir("ns-skills-");
  // Read by the fake claude binary, which inherits the server's environment.
  const argsLog = join(tempDir("ns-args-"), "args.jsonl");
  process.env.FAKE_ARGS_LOG = argsLog;
  // Short fake runs: a test that acts while a run is live uses a "slow" card (FAKE_SLOW_MS), never this delay.
  process.env.FAKE_DELAY_MS = "50";
  afterAll(removeTempDirs);
  return { argsLog };
}

export type AttentionEvent = { type: "attention"; project: string; cardId: string; kind: string };

/** Sets the env, then starts one server for the file (stopped after its last test) with the fake claude binary. */
export async function startNightshiftServer() {
  const { argsLog } = nightshiftEnv();
  const { skillsDir } = await import("../src/server/skills.ts");
  const { startServer } = await import("../src/server/server.ts");
  const { updateSettings, NIGHTSHIFT_HOME } = await import("../src/server/settings.ts");
  const home = NIGHTSHIFT_HOME;
  const userSkills = skillsDir("user", "");
  updateSettings({ claudePath: join(import.meta.dir, "fake-claude.ts") });
  const srv = startServer({ port: 0 });
  const base = `http://localhost:${srv.server.port}`;
  mkdirSync(join(userSkills, "enrich"), { recursive: true });
  writeFileSync(join(userSkills, "enrich", "SKILL.md"), "---\nname: enrich\ndescription: test\n---\n");
  afterAll(async () => {
    await srv.orch.shutdown();
    srv.server.stop(true);
  });

  const post = (path: string, body: object, method = "POST") =>
    fetch(base + path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());

  const getProject = (path: string) => fetch(`${base}/api/project?project=${encodeURIComponent(path)}`).then((r) => r.json());

  const liveRunning = async (project: string) => {
    const s = await getProject(project);
    return { running: Object.values(s.live).filter((v) => v === "running").length, idle: Object.keys(s.live).length === 0, board: s.board };
  };

  /** One entry per fake claude run of this file; empty before the first run (the log does not exist yet). */
  const argsEntries = (): { title: string; resumed: boolean; model: string | null }[] =>
    existsSync(argsLog)
      ? readFileSync(argsLog, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];

  /** Fresh project with the given columns; collects the attention events of that project only. */
  async function attentionBoard(columns: object[]) {
    updateSettings({ claudePath: join(import.meta.dir, "fake-claude.ts") });
    const dir = tempDir("ns-attn-");
    await post("/api/projects/open", { path: dir });
    const res = await post("/api/board", { project: dir, columns }, "PUT");
    const events: AttentionEvent[] = [];
    const stop = srv.orch.on((e) => {
      if (e.type === "attention" && e.project === dir) events.push(e);
    });
    const card = async (id: string) => (await getProject(dir)).board.cards.find((c: Card) => c.id === id);
    const idle = async (id: string) => !(await getProject(dir)).live[id];
    const forCard = (id: string) => events.filter((e) => e.cardId === id);
    return {
      dir, // Without the Backlog the server puts first: the tests address the columns they sent.
      cols: (res.board.columns as Column[]).slice(1),
      events,
      stop,
      card,
      idle,
      forCard,
    };
  }

  /** Project where a card runs through "Work" and lands in the inert "To Test", ready to receive feedback. */
  async function feedbackBoard(extra: object[] = []) {
    const b = await attentionBoard([
      { name: "Work", type: "skill", skill: "enrich" },
      { name: "To Test", type: "inert", emoji: "🪲" },
      ...extra,
    ]);
    const [work, toTest] = b.cols;
    const landed = async (title: string) => {
      const { id } = await post("/api/cards", { project: b.dir, columnId: work.id, title });
      await waitFor(async () => (await b.card(id))?.columnId === toTest.id && (await b.idle(id)));
      return id as string;
    };
    const send = (id: string, text: string) => post(`/api/cards/${id}/feedback`, { project: b.dir, text });
    const settled = (id: string, ok: (c: Card) => boolean) => waitFor(async () => ok(await b.card(id)) && (await b.idle(id)));
    return { ...b, work, toTest, landed, send, settled };
  }

  /** Fresh project: Backlog, a skill column "Enrich" (skill enrich) and an inert "Done". */
  async function openSkillBoard(prefix: string, maxParallel?: number) {
    const dir = tempDir(prefix);
    await post("/api/projects/open", { path: dir });
    const res = await post(
      "/api/board",
      {
        project: dir,
        columns: [
          { name: "Backlog", type: "inert" },
          { name: "Enrich", type: "skill", skill: "enrich", ...(maxParallel ? { maxParallel } : {}) },
          { name: "Done", type: "inert" },
        ],
      },
      "PUT",
    );
    return { dir, backlog: res.board.columns[0], enrich: res.board.columns[1], done: res.board.columns[2] };
  }

  return {
    srv,
    base,
    home,
    userSkills,
    argsLog,
    post,
    getProject,
    liveRunning,
    argsEntries,
    attentionBoard,
    feedbackBoard,
    openSkillBoard,
  };
}
