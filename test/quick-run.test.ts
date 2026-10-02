import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProjectSnapshot, QuickRunResult, ServerEvent } from "../src/shared/types.ts";
import { removeTempDirs, tempDir, waitFor } from "./helpers.ts";

// The server, orchestrator and settings modules keep process-wide singletons (NIGHTSHIFT_HOME is read at
// import, settings live on globalThis) and `bun test` shares them across files. The scenarios therefore run
// in a child `bun test` of this very file with its own home.
const CHILD = process.env.QUICK_RUN_CHILD === "1";
const NAMES = [
  "quick-run-success",
  "quick-run-errors",
  "quick-run-rejects",
  "quick-run-project-cap",
  "quick-run-cancel",
  "quick-run-progress",
  "quick-run-log-retention",
  "quick-run-shutdown",
];

if (!CHILD) {
  test("quick-run-isolated: scenarios pass in a dedicated process", async () => {
    const proc = Bun.spawn([process.execPath, "test", import.meta.path], {
      env: { ...process.env, QUICK_RUN_CHILD: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0) console.error(out + err);
    expect(code).toBe(0);
    for (const name of NAMES) expect(out + err).toContain(`(pass) ${name}`);
  }, 120000);
} else {
  const home = tempDir("ns-quick-home-");
  const userSkills = tempDir("ns-quick-skills-");
  const argsLog = join(tempDir("ns-quick-args-"), "args.jsonl");
  process.env.NIGHTSHIFT_HOME = home;
  process.env.NIGHTSHIFT_USER_SKILLS = userSkills;
  process.env.FAKE_DELAY_MS = "300";
  process.env.FAKE_ARGS_LOG = argsLog;

  const { Orchestrator } = await import("../src/server/orchestrator.ts");
  const { startServer } = await import("../src/server/server.ts");
  const { updateSettings, NIGHTSHIFT_HOME } = await import("../src/server/settings.ts");

  let srv: ReturnType<typeof startServer>;
  let base = "";
  const events: ServerEvent[] = [];

  beforeAll(() => {
    updateSettings({ claudePath: join(import.meta.dir, "fake-claude.ts") });
    srv = startServer({ port: 0 });
    base = `http://localhost:${srv.server.port}`;
    srv.orch.on((e) => events.push(e));
  });
  afterAll(async () => {
    await srv.orch.shutdown();
    srv.server.stop(true);
    removeTempDirs();
  });

  const call = (path: string, body: object, method = "POST") =>
    fetch(base + path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const post = (path: string, body: object, method = "POST") => call(path, body, method).then((r) => r.json());
  const snap = (dir: string): Promise<ProjectSnapshot> =>
    fetch(`${base}/api/project?project=${encodeURIComponent(dir)}`).then((r) => r.json());

  function writeSkill(dir: string, name: string) {
    mkdirSync(join(dir, ".claude", "skills", name), { recursive: true });
    writeFileSync(join(dir, ".claude", "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: test\n---\n`);
  }

  /** Opens a fresh project whose listed skills all exist and are favorites. */
  async function setup(skills: string[] = ["deploy"]) {
    const dir = tempDir("ns-quick-proj-");
    await post("/api/projects/open", { path: dir });
    for (const s of skills) {
      writeSkill(dir, s);
      const r = await call("/api/favorite-skills", { project: dir, name: s, favorite: true }, "PUT");
      expect(r.status).toBe(200);
    }
    return dir;
  }

  const run = (dir: string, skill: string, instruction?: string): Promise<{ id: string }> =>
    post("/api/quick-runs", { project: dir, skill, ...(instruction === undefined ? {} : { instruction }) });
  const resultOf = (id: string) => () => events.find((e) => e.type === "quickrun" && e.result.id === id);
  const waitResult = async (id: string): Promise<QuickRunResult> => {
    await waitFor(() => !!resultOf(id)());
    const e = resultOf(id)();
    if (e?.type !== "quickrun") throw new Error("no result");
    return e.result;
  };
  const runState = async (dir: string, id: string) => (await snap(dir)).quickRuns.find((q) => q.id === id);

  test("quick-run-success", async () => {
    const dir = await setup();
    const { id } = await run(dir, "deploy", "  v1.4  ");
    await waitFor(async () => (await runState(dir, id))?.status === "running");
    const result = await waitResult(id);
    expect(result.status).toBe("success");
    expect(result.summary).toContain("v1.4");
    expect(result.instruction).toBe("v1.4");
    // The result is emitted before the board snapshot that no longer holds the run.
    const resultAt = events.findIndex((e) => e.type === "quickrun" && e.result.id === id);
    const board = (i: number) => {
      const e = events[i];
      return e?.type === "board" && e.project === dir ? e.snapshot : undefined;
    };
    const firstWithRun = events.findIndex((_e, i) => board(i)?.quickRuns.some((q) => q.id === id));
    const firstWithout = events.findIndex((_e, i) => i > firstWithRun && board(i) && !board(i)?.quickRuns.some((q) => q.id === id));
    expect(firstWithRun).toBeGreaterThanOrEqual(0);
    expect(firstWithout).toBeGreaterThan(resultAt);
    await waitFor(async () => (await snap(dir)).quickRuns.length === 0);
    const entry = readFileSync(argsLog, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .find((l) => l.promptHasQuick && String(l.prompt).includes("v1.4"));
    expect(entry).toBeDefined();
    expect(entry.argv.join(" ")).not.toContain("v1.4");
    expect(entry.prompt).toContain("<instruction>");
  });

  test("quick-run-errors", async () => {
    const dir = await setup(["deploy", "gone"]);
    for (const instruction of ["FAKE_QUICK_ERROR", "FAKE_QUICK_INVALID"]) {
      const { id } = await run(dir, "deploy", instruction);
      const r = await waitResult(id);
      expect(r.status).toBe("error");
      expect((r.error ?? "").length).toBeGreaterThan(0);
    }
    rmSync(join(dir, ".claude", "skills", "gone"), { recursive: true });
    const { id } = await run(dir, "gone");
    const r = await waitResult(id);
    expect(r.status).toBe("error");
    expect(r.error).toContain("gone");
  });

  test("quick-run-rejects", async () => {
    const dir = await setup(["deploy"]);
    writeSkill(dir, "other");
    expect((await call("/api/quick-runs", { project: dir, skill: "other" })).status).toBe(400);
    expect((await call("/api/quick-runs", { project: dir, skill: "deploy", instruction: "x".repeat(2001) })).status).toBe(400);

    // --no-agents: the orchestrator refuses.
    const noAgents = new Orchestrator({ agents: false });
    const p = noAgents.open(dir);
    p.mutate((b) => {
      b.favoriteSkills = ["deploy"];
    });
    expect(() => noAgents.queueQuickRun(p, "deploy", "")).toThrow();
    await noAgents.shutdown();

    // Project run by another live Nightshift process (this test's parent).
    const locked = tempDir("ns-quick-locked-");
    mkdirSync(join(NIGHTSHIFT_HOME, "locks"), { recursive: true });
    const lock = createHash("sha1").update(locked).digest("hex").slice(0, 12);
    writeFileSync(join(NIGHTSHIFT_HOME, "locks", `${lock}.lock`), String(process.ppid));
    await post("/api/projects/open", { path: locked });
    expect((await snap(locked)).lockedBy).toBe(process.ppid);
    expect((await call("/api/quick-runs", { project: locked, skill: "deploy" })).status).toBe(409);
  });

  test("quick-run-project-cap", async () => {
    const dir = await setup(["deploy", "other"]);
    writeSkill(dir, "enrich");
    await post("/api/board", { project: dir, maxParallel: 1 }, "PUT");
    const first = await run(dir, "other", "FAKE_QUICK_SLOW");
    await waitFor(async () => (await runState(dir, first.id))?.status === "running");
    const second = await run(dir, "deploy", "second");
    const board = await post(
      "/api/board",
      {
        project: dir,
        columns: [
          { name: "Work", type: "skill", skill: "enrich" },
          { name: "Done", type: "inert" },
        ],
      },
      "PUT",
    );
    const card = await post("/api/cards", { project: dir, columnId: board.board.columns[1].id, title: "waiting" });
    expect((await runState(dir, second.id))?.status).toBe("queued");
    expect((await snap(dir)).live[card.id]).toBe("queued");
    expect((await waitResult(first.id)).status).toBe("success");
    // The queued quick run gets the freed slot before the card that has been waiting.
    await waitFor(async () => (await runState(dir, second.id))?.status === "running");
    expect((await snap(dir)).live[card.id]).toBe("queued");
    expect((await waitResult(second.id)).status).toBe("success");
    await waitFor(async () => (await snap(dir)).live[card.id] === "running");
  }, 30000);

  test("quick-run-cancel", async () => {
    const dir = await setup(["deploy", "other"]);
    writeSkill(dir, "enrich");
    await post("/api/board", { project: dir, maxParallel: 2 }, "PUT");
    const board = await post(
      "/api/board",
      {
        project: dir,
        columns: [
          { name: "Work", type: "skill", skill: "enrich" },
          { name: "Done", type: "inert" },
        ],
      },
      "PUT",
    );
    const card = await post("/api/cards", { project: dir, columnId: board.board.columns[1].id, title: "slow" });
    await waitFor(async () => (await snap(dir)).live[card.id] === "running");
    const running = await run(dir, "other", "FAKE_QUICK_SLOW");
    await waitFor(async () => (await runState(dir, running.id))?.status === "running");
    const queued = await run(dir, "deploy", "later");
    expect((await runState(dir, queued.id))?.status).toBe("queued");

    expect(await post(`/api/quick-runs/${queued.id}/cancel`, { project: dir })).toEqual({ ok: true });
    expect((await waitResult(queued.id)).status).toBe("cancelled");
    expect(await post(`/api/quick-runs/${running.id}/cancel`, { project: dir })).toEqual({ ok: true });
    expect((await waitResult(running.id)).status).toBe("cancelled");
    expect(await post("/api/quick-runs/qr_unknown/cancel", { project: dir })).toEqual({ ok: false });

    // The card's own agent was not touched.
    expect((await snap(dir)).live[card.id]).toBe("running");
    await waitFor(async () => (await snap(dir)).board.cards.find((c) => c.id === card.id)?.lastRun?.status === "success");
    expect((await snap(dir)).quickRuns).toEqual([]);
  }, 30000);

  test("quick-run-progress", async () => {
    const dir = await setup();
    const { id } = await run(dir, "deploy", "FAKE_QUICK_PROGRESS FAKE_QUICK_SLOW");
    await waitFor(async () => !!(await runState(dir, id))?.progress);
    const q = await runState(dir, id);
    expect(q?.progress).toMatchObject({ step: 1, total: 2, source: "marker" });
    await post(`/api/quick-runs/${id}/cancel`, { project: dir });
    expect((await waitResult(id)).status).toBe("cancelled");
  });

  test("quick-run-log-retention", async () => {
    const dir = await setup();
    const logDir = join(NIGHTSHIFT_HOME, "logs", createHash("sha1").update(dir).digest("hex").slice(0, 12));
    const prefix = `quick-${createHash("sha1").update("deploy").digest("hex").slice(0, 8)}-`;
    const logs = () => readdirSync(logDir).filter((n) => n.startsWith(prefix));
    const first = await run(dir, "deploy", "one");
    await waitResult(first.id);
    expect(logs()).toEqual([`${prefix}${first.id}.jsonl`]);
    const second = await run(dir, "deploy", "two");
    await waitResult(second.id);
    expect(logs()).toEqual([`${prefix}${second.id}.jsonl`]);
    // Never served as a card log.
    const res = await fetch(`${base}/api/cards/${prefix}${second.id}/log?project=${encodeURIComponent(dir)}`);
    expect(await res.json()).toEqual([]);
  });

  test("quick-run-shutdown", async () => {
    const dir = await setup();
    const orch = new Orchestrator();
    const p = orch.open(dir);
    const id = orch.queueQuickRun(p, "deploy", "FAKE_QUICK_SLOW");
    const jobs = (orch as unknown as { quickRuns: Map<string, { proc?: { pid: number } }> }).quickRuns;
    await waitFor(() => !!jobs.get(id)?.proc?.pid);
    const proc = jobs.get(id)?.proc;
    if (!proc) throw new Error("no process");
    await orch.shutdown();
    expect(() => process.kill(proc.pid, 0)).toThrow();
  });
}
