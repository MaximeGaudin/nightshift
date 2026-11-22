import { expect, test } from "bun:test";
import type { LogLine } from "../src/shared/types.ts";
import { waitFor } from "./helpers.ts";
import { startNightshiftServer } from "./nightshift-helpers.ts";

const { base, post, getProject, feedbackBoard } = await startNightshiftServer();

test("feedback in inert column ignores the column limit and survives cancelStaleJobs", async () => {
  const b = await feedbackBoard();
  try {
    const ids = [await b.landed("go1"), await b.landed("go2")];
    let maxRunning = 0;
    await Promise.all(ids.map((id) => b.send(id, "both FAKE_MOVE=stay")));
    await waitFor(async () => {
      const s = await getProject(b.dir);
      maxRunning = Math.max(maxRunning, Object.values(s.live).filter((v) => v === "running").length);
      return Object.keys(s.live).length === 0;
    });
    expect(maxRunning).toBe(2);
    for (const id of ids) {
      const card = await b.card(id);
      expect(card.lastRun.status).toBe("success");
      expect(card.lastRun.summary).toBe("feedback applied");
      expect(card.columnId).toBe(b.toTest.id);
      const log = await fetch(`${base}/api/cards/${id}/log?project=${encodeURIComponent(b.dir)}`).then((r) => r.json());
      expect(log.some((l: LogLine) => l.text.includes("stopping agent"))).toBe(false);
    }
  } finally {
    b.stop();
  }
});

test("feedback is refused without session or while queued", async () => {
  const b = await feedbackBoard();
  try {
    const fresh = await post("/api/cards", { project: b.dir, columnId: b.toTest.id, title: "fresh" });
    expect((await b.send(fresh.id, "hello")).error).toBe("This card has no session to send feedback to");
    const id = await b.landed("go");
    expect((await b.send(id, "   ")).error).toBe("Empty feedback");
    expect((await b.send(id, "first FAKE_MOVE=stay")).error).toBeUndefined();
    expect((await b.send(id, "second")).error).toBe("This card has no session to send feedback to");
    await b.settled(id, (c) => c.lastRun?.summary === "feedback applied");
    expect((await b.send(id, "third FAKE_MOVE=stay")).error).toBeUndefined();
    await b.settled(id, (c) => c.description.includes("<feedback>\nthird"));
  } finally {
    b.stop();
  }
});

test("failed feedback leaves the card in place", async () => {
  const b = await feedbackBoard();
  try {
    const id = await b.landed("go");
    await b.send(id, "break FAKE_FAIL");
    await b.settled(id, (c) => c.lastRun?.status === "error");
    let card = await b.card(id);
    expect(card.columnId).toBe(b.toTest.id);
    expect(card.pendingAnswer).toBeUndefined();
    expect(card.lastRun.sessionId).toBeDefined();
    expect((await b.send(id, "again FAKE_MOVE=stay")).error).toBeUndefined();
    await b.settled(id, (c) => c.lastRun?.status === "success");
    card = await b.card(id);
    expect(card.columnId).toBe(b.toTest.id);
  } finally {
    b.stop();
  }
});

test("cancelled feedback keeps the session so feedback can be sent again", async () => {
  const b = await feedbackBoard();
  try {
    const id = await b.landed("go");
    await b.send(id, "wait FAKE_SLOW FAKE_MOVE=stay");
    await waitFor(async () => (await getProject(b.dir)).live[id] === "running");
    expect((await post(`/api/cards/${id}/cancel`, { project: b.dir })).cancelled).toBe(true);
    await b.settled(id, (c) => c.lastRun?.status === "cancelled");
    const card = await b.card(id);
    expect(card.columnId).toBe(b.toTest.id);
    expect(card.lastRun.sessionId).toBeDefined();
    expect((await b.send(id, "again FAKE_MOVE=stay")).error).toBeUndefined();
    await b.settled(id, (c) => c.lastRun?.status === "success");
  } finally {
    b.stop();
  }
});
