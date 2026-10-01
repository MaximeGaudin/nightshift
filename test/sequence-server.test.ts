import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { type ChildServer, removeTempDirs, startChildServer, waitFor } from "./helpers.ts";

let live: ChildServer;
let idle: ChildServer;

beforeAll(async () => {
  live = await startChildServer({ agents: true });
  idle = await startChildServer({ agents: false });
});
afterAll(async () => {
  await live?.stop();
  await idle?.stop();
  removeTempDirs();
});

async function open(srv: ChildServer) {
  const dir = mkdtempSync(join(srv.tmp, "proj-"));
  await srv.call("/api/projects/open", { body: { path: dir } });
  return dir;
}

test("seq-srv-routes", async () => {
  const dir = await open(live);
  const snap = () => live.call(`/api/project?project=${encodeURIComponent(dir)}`).then((r) => r.json());
  expect((await snap()).sequence).toEqual({ status: "stopped" });

  const ws = new WebSocket(`${live.base.replace("http", "ws")}/ws`);
  const seen: string[] = [];
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(String(e.data));
    if (m.type === "board" && m.project === dir) seen.push(m.snapshot.sequence.status);
  });
  await new Promise((r) => ws.addEventListener("open", r));

  // Inert columns only: the launched card just sits in the entry column, no agent involved.
  await live.call("/api/board", {
    method: "PUT",
    body: {
      project: dir,
      columns: [
        { name: "Backlog", type: "inert" },
        { name: "Hold", type: "inert" },
      ],
    },
  });
  const board = await snap();
  await live.call("/api/cards", { body: { project: dir, columnId: board.board.columns[0].id, title: "A" } });

  const play = await live.call("/api/sequence/play", { body: { project: dir } });
  expect(play.status).toBe(200);
  const played = (await play.json()).sequence;
  expect(played.status).toBe("active");
  expect(played.cardId).toBeString();
  expect((await snap()).sequence.status).toBe("active");
  await waitFor(() => seen.includes("active"));

  const pause = await live.call("/api/sequence/pause", { body: { project: dir } });
  expect((await pause.json()).sequence).toEqual({ status: "paused", cardId: played.cardId });
  await waitFor(() => seen.includes("paused"));
  ws.close();
});

test("seq-srv-routes refuses play on an agents:false instance", async () => {
  const dir = await open(idle);
  const r = await idle.call("/api/sequence/play", { body: { project: dir } });
  expect(r.status).toBe(409);
  expect((await r.json()).error).toBe("This instance does not run agents for this project");
  const snap = await idle.call(`/api/project?project=${encodeURIComponent(dir)}`).then((x) => x.json());
  expect(snap.sequence).toEqual({ status: "stopped" });
});
