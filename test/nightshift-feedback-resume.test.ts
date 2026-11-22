import { expect, test } from "bun:test";
import type { HistoryEntry, LogLine } from "../src/shared/types.ts";
import { startNightshiftServer } from "./nightshift-helpers.ts";

const { base, post, feedbackBoard, argsEntries } = await startNightshiftServer();

test("feedback in inert column resumes the session and applies move", async () => {
  const b = await feedbackBoard();
  try {
    const id = await b.landed("go");
    const before = argsEntries().length;
    expect((await b.send(id, "fix FAKE_MOVE=stay")).error).toBeUndefined();
    await b.settled(id, (c) => c.title === "feedback done");
    const card = await b.card(id);
    expect(
      argsEntries()
        .slice(before)
        .filter((e) => e.resumed),
    ).toHaveLength(1);
    expect(card.columnId).toBe(b.toTest.id);
    expect(card.lastRun.columnId).toBe(b.toTest.id);
    expect(card.lastRun.status).toBe("success");
    expect(card.lastRun.sessionId).toBeDefined();
    expect(card.lastRun.skill).toBe("enrich");
    expect(card.pendingAnswer).toBeUndefined();
    expect(card.description).toContain("<feedback>\nfix FAKE_MOVE=stay\n</feedback>");
    expect(card.description).toContain(`(id: ${b.toTest.id}, inert)`);
    expect(card.description).toContain("Board columns, in order:");
    expect(card.description).toContain(`2. Work (id: ${b.work.id}, skill: enrich)`);
    expect(card.description).toContain('the skill "enrich"');
    expect(card.history.some((h: HistoryEntry) => h.text === "Feedback sent to agent")).toBe(true);
    const log = await fetch(`${base}/api/cards/${id}/log?project=${encodeURIComponent(b.dir)}`).then((r) => r.json());
    expect(log.some((l: LogLine) => l.text.startsWith("Retour utilisateur : fix"))).toBe(true);
  } finally {
    b.stop();
  }
});

test("feedback move next goes to the column after the current one", async () => {
  const b = await feedbackBoard([{ name: "Review", type: "skill", skill: "enrich" }]);
  try {
    const review = b.cols[2];
    const id = await b.landed("go");
    await b.send(id, "ship it FAKE_MOVE=next");
    await b.settled(id, (c) => c.columnId !== b.toTest.id && c.lastRun?.columnId === review.id);
    const entries = argsEntries().filter((e) => e.title === "feedback done ✓" || e.title === "feedback done");
    expect(entries.some((e) => !e.resumed)).toBe(true);
    expect((await b.card(id)).history.some((h: HistoryEntry) => h.kind === "run" && h.text.startsWith("Review:"))).toBe(true);
  } finally {
    b.stop();
  }
});

test("second feedback keeps the session skill", async () => {
  const b = await feedbackBoard();
  try {
    const id = await b.landed("go");
    await b.send(id, "one FAKE_MOVE=stay");
    await b.settled(id, (c) => c.lastRun?.summary === "feedback applied");
    await b.send(id, "two FAKE_MOVE=stay");
    await b.settled(id, (c) => c.description.includes("<feedback>\ntwo"));
    const card = await b.card(id);
    expect(card.columnId).toBe(b.toTest.id);
    expect(card.description).toContain('Follow the skill "enrich"');
    expect(card.lastRun.skill).toBe("enrich");
  } finally {
    b.stop();
  }
});

test("feedback question in inert column can be answered", async () => {
  const b = await feedbackBoard();
  try {
    const id = await b.landed("go");
    await b.send(id, "hmm FAKE_ASK");
    await b.settled(id, (c) => c.lastRun?.status === "question");
    let card = await b.card(id);
    expect(card.columnId).toBe(b.toTest.id);
    expect(card.lastRun.questions).toEqual(["Which one?"]);
    const before = argsEntries().length;
    expect((await post(`/api/cards/${id}/answer`, { project: b.dir, answers: ["the blue one"] })).error).toBeUndefined();
    await b.settled(id, (c) => c.lastRun?.status === "success" && c.lastRun.summary === "resumed");
    card = await b.card(id);
    expect(
      argsEntries()
        .slice(before)
        .filter((e) => e.resumed),
    ).toHaveLength(1);
    expect(card.description).toContain("A1: the blue one");
    expect(card.description).toContain('with the skill "enrich"');
  } finally {
    b.stop();
  }
});
