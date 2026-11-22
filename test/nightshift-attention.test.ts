import { expect, test } from "bun:test";
import { waitFor } from "./helpers.ts";
import { startNightshiftServer } from "./nightshift-helpers.ts";

const { post, getProject, attentionBoard } = await startNightshiftServer();

test("attention: run ending in an inert column emits inert", async () => {
  const b = await attentionBoard([
    { name: "Work", type: "skill", skill: "enrich" },
    { name: "Done", type: "inert" },
  ]);
  try {
    const [work, done] = b.cols;
    const { id } = await post("/api/cards", { project: b.dir, columnId: work.id, title: "go" });
    await waitFor(async () => (await b.card(id))?.columnId === done.id && (await b.idle(id)));
    await waitFor(() => b.forCard(id).length > 0);
    expect(b.forCard(id)).toEqual([{ type: "attention", project: b.dir, cardId: id, kind: "inert" }]);
  } finally {
    b.stop();
  }
});

test("attention: question emits question", async () => {
  const b = await attentionBoard([
    { name: "Work", type: "skill", skill: "enrich" },
    { name: "Done", type: "inert" },
  ]);
  try {
    const { id } = await post("/api/cards", { project: b.dir, columnId: b.cols[0].id, title: "ask" });
    await waitFor(async () => (await b.card(id))?.lastRun?.status === "question" && (await b.idle(id)));
    await waitFor(() => b.forCard(id).length > 0);
    expect(b.forCard(id)).toEqual([{ type: "attention", project: b.dir, cardId: id, kind: "question" }]);
  } finally {
    b.stop();
  }
});

test("attention: error emits error", async () => {
  const b = await attentionBoard([
    { name: "Work", type: "skill", skill: "enrich" },
    { name: "Missing", type: "skill", skill: "no-such-skill-xyz" },
    { name: "Done", type: "inert" },
  ]);
  try {
    const [work, missing] = b.cols;
    const failed = await post("/api/cards", { project: b.dir, columnId: work.id, title: "fail" });
    const unknown = await post("/api/cards", { project: b.dir, columnId: missing.id, title: "m" });
    for (const id of [failed.id, unknown.id])
      await waitFor(async () => (await b.card(id))?.lastRun?.status === "error" && (await b.idle(id)));
    await waitFor(() => b.forCard(failed.id).length > 0 && b.forCard(unknown.id).length > 0);
    expect(b.forCard(failed.id)).toEqual([{ type: "attention", project: b.dir, cardId: failed.id, kind: "error" }]);
    expect(b.forCard(unknown.id)).toEqual([{ type: "attention", project: b.dir, cardId: unknown.id, kind: "error" }]);
  } finally {
    b.stop();
  }
});

test("attention: manual move into inert column emits nothing", async () => {
  const b = await attentionBoard([
    { name: "Inbox", type: "inert" },
    { name: "Done", type: "inert" },
  ]);
  try {
    const [inbox, done] = b.cols;
    const { id } = await post("/api/cards", { project: b.dir, columnId: inbox.id, title: "manual" });
    await post(`/api/cards/${id}/move`, { project: b.dir, columnId: done.id });
    // No wait: attention is only broadcast when a run finishes (Orchestrator.finish), and the passes a move triggers run
    // in microtasks before the server answers the next request.
    expect((await b.card(id)).columnId).toBe(done.id);
    expect(b.forCard(id)).toEqual([]);
  } finally {
    b.stop();
  }
});

test("attention: cancelled run emits nothing", async () => {
  const b = await attentionBoard([
    { name: "Work", type: "skill", skill: "enrich" },
    { name: "Done", type: "inert" },
  ]);
  try {
    const [work, done] = b.cols;
    const running = async (id: string) => (await getProject(b.dir)).live[id] === "running";

    const cancelled = await post("/api/cards", { project: b.dir, columnId: work.id, title: "slow" });
    await waitFor(() => running(cancelled.id));
    expect((await post(`/api/cards/${cancelled.id}/cancel`, { project: b.dir })).cancelled).toBe(true);
    await waitFor(() => b.idle(cancelled.id), 4000);
    expect((await b.card(cancelled.id)).lastRun?.status).toBe("cancelled");

    const moved = await post("/api/cards", { project: b.dir, columnId: work.id, title: "slow" });
    await waitFor(() => running(moved.id));
    await post(`/api/cards/${moved.id}/move`, { project: b.dir, columnId: done.id });
    await waitFor(() => b.idle(moved.id), 4000);
    // No wait: a run's attention is broadcast in Orchestrator.finish, before its job is removed (start().finally), so an
    // idle card has already emitted whatever it would.
    expect(b.forCard(cancelled.id)).toEqual([]);
    expect(b.forCard(moved.id)).toEqual([]);
  } finally {
    b.stop();
  }
}, 15000);

test("attention: move into a skill column emits nothing; stay without questions rings as needing attention", async () => {
  const b = await attentionBoard([
    { name: "A", type: "skill", skill: "enrich" },
    { name: "B", type: "skill", skill: "enrich" },
    { name: "Done", type: "inert" },
  ]);
  try {
    const [a, , done] = b.cols;
    const stay = await post("/api/cards", { project: b.dir, columnId: a.id, title: "stay" });
    const flow = await post("/api/cards", { project: b.dir, columnId: a.id, title: "flow" });
    await waitFor(async () => (await b.card(stay.id))?.lastRun?.status === "attention" && (await b.idle(stay.id)));
    await waitFor(async () => (await b.card(flow.id))?.columnId === done.id && (await b.idle(flow.id)));
    await waitFor(() => b.forCard(flow.id).length > 0);
    // No wait: both cards are idle, and attention is broadcast in Orchestrator.finish before the job is removed.
    expect((await b.card(stay.id)).columnId).toBe(a.id);
    expect(b.forCard(stay.id)).toEqual([{ type: "attention", project: b.dir, cardId: stay.id, kind: "error" }]);
    expect(b.forCard(flow.id)).toEqual([{ type: "attention", project: b.dir, cardId: flow.id, kind: "inert" }]);
  } finally {
    b.stop();
  }
}, 10000);

test("attention: answering emits nothing, resumed run follows the rules", async () => {
  const b = await attentionBoard([
    { name: "Work", type: "skill", skill: "enrich" },
    { name: "Done", type: "inert" },
  ]);
  try {
    const [work, done] = b.cols;
    const { id } = await post("/api/cards", { project: b.dir, columnId: work.id, title: "ask" });
    await waitFor(async () => b.forCard(id).length === 1 && (await b.idle(id)));
    expect(b.forCard(id)[0].kind).toBe("question");
    // The resumed run takes at least the fake delay, so any event seen right after the answer came from answer() itself.
    await post(`/api/cards/${id}/answer`, { project: b.dir, answers: ["blue", "big"] });
    expect(b.forCard(id)).toHaveLength(1);
    await waitFor(async () => (await b.card(id))?.columnId === done.id && (await b.idle(id)));
    await waitFor(() => b.forCard(id).length > 1);
    expect(b.forCard(id).map((e) => e.kind)).toEqual(["question", "inert"]);
  } finally {
    b.stop();
  }
}, 10000);
